import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/brand-logo";
import { ChevronBackward } from "@/components/ui/directional-icon";
import { tr, trf, getCurrentLang } from "@/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useLanguage } from "@/hooks/use-language";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Virtuoso } from "react-virtuoso";
import DOMPurify from "dompurify";
import {
  sanitizeAndHardenEmailHtml,
  buildEmailSrcDoc,
  isAllowedInlineImageDataUri,
  isValidCidApplyPayload,
  isValidLargeCidApplyPayload,
  isValidHeightPayload,
  randomToken,
} from "@/lib/email-viewer-security";
import type { CidImageMapping, LargeCidByteMapping } from "@/lib/email-viewer-security";
import {
  partitionInlineCidParts,
  chunkInlineCidParts,
  fetchInlineCidPartsBatch,
  streamInlineCidPartsSequential,
  readLargeInlineCidSessionCache,
  storeLargeInlineCidSessionCache,
  clearLargeInlineCidSessionCache,
} from "@/lib/mail-inline-cid-policy";

import { buildReplyQuoteHtml, buildForwardQuoteHtml } from "@/lib/mail-quote";
import {
  buildReplyRecipients,
  buildThreadingHeaders,
  forwardSubject,
  formatComposeAddress,
  replySubject,
} from "@/lib/mail-reply-metadata";
import {
  markQuotedCidImagesPending,
  prepareQuotedEmailForComposer,
  removeUnresolvedQuotedCidImage,
} from "@/lib/mail-compose-quote";
import { splitQuotedHtml, trimHistoricalQuotedContent } from "@/lib/mail-thread-split";
import {
  ATTACHMENT_PREPARATION_MESSAGE_KEY,
  getOrCreateStagedUpload,
  getStagedReady,
  setStagedReady,
  uploadAttachmentDirect,
  type StagedReadyCache,
  type StagedAttachmentKind,
  type StagedAttachmentResult,
  type StagedUploadCache,
  isAttachmentPreparationProtocolError,
  isAttachmentSizeLimitError,
  shouldReleaseAbandonedStagedResult,
} from "@/lib/mail-attachment-staging";
import {
  buildStagedAttachmentTransport,
  buildLocalSourceAttachmentState,
  buildAttachmentTransportPlan,
  deriveAttachmentSourceRef,
  selectNormalComposerAttachments,
  classifyAttachmentLimitExceeded,
  COMPOSE_MAX_TOTAL_BYTES,
  COMPOSE_MAX_NORMAL_ATTACHMENTS,
  COMPOSE_MAX_INLINE_IMAGES,
  type AttachmentSourceRef,
} from "@/lib/mail-composer-attachments";
import { runEntireMessageSingleFlight, samePhysicalMessage } from "@/lib/mail-entire-message";
import { releaseStagedHandles } from "@/lib/mail-staged-release.browser";
import { deliveryProgressForElapsed } from "@/lib/mail-send-progress";

// Kept as a thin wrapper — the heavy lifting (DOMPurify + CSS url()/@import
// stripping + anchor hardening) lives in `@/lib/email-viewer-security` and is
// covered by dedicated tests.
function sanitizeEmailHtml(html: string): string {
  return sanitizeAndHardenEmailHtml(html);
}

// Sanitizer for OUTGOING composer HTML — allows inline styles/fonts/colors
// (needed for email) but blocks scripts, event handlers, and dangerous tags.
function sanitizeComposerHtml(html: string): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta", "base", "style"],
    FORBID_ATTR: ["srcdoc", "formaction", "onerror", "onload", "onclick", "onmouseover", "onfocus"],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["data-mm-preserve-layout", "data-mm-quoted-content"],
  });
}

function hydrateComposerDirection(editor: HTMLElement, direction: unknown): void {
  if (direction !== "rtl" && direction !== "ltr") return;
  editor.dir = direction;
  editor.style.textAlign = direction === "rtl" ? "right" : "left";
}

function rotatingToken(identity: string, prefix = ""): string {
  return `${prefix}${randomToken(12)}${identity.length.toString(36)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

/**
 * EmailBodyFrame — renders sanitized email HTML inside a sandboxed iframe with
 * a strict Content-Security-Policy. The sandbox has NO `allow-same-origin`,
 * so the document's origin is opaque ("null"). Only a per-render nonce'd
 * measurement script may run; it posts height updates to the parent using
 * the exact parent origin and a per-render channelId, both verified on
 * receive. Links open in a new top-level tab and never leak referrer.
 */
function EmailBodyFrame({
  html,
  cidImages,
  messageIdentity,
  className,
  onReady,
  largeCidDispatcherRef,
}: {
  html: string;
  cidImages: CidImageMapping[];
  messageIdentity: string;
  className?: string;
  onReady?: () => void;
  largeCidDispatcherRef?: { current: ((images: LargeCidByteMapping[]) => void) | null };
}) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const nonce = useMemo(() => rotatingToken(`${messageIdentity}|${html}`), [html, messageIdentity]);
  const channelId = useMemo(
    () => rotatingToken(`${messageIdentity}|${html}`, "mm-"),
    [html, messageIdentity],
  );
  const generation = useMemo(
    () => rotatingToken(`${messageIdentity}|${html}`),
    [html, messageIdentity],
  );
  const [height, setHeight] = useState<number>(60);
  // HTTPS images load in the sandbox from the first render. This matches the
  // expected mail-client behaviour while text still paints independently;
  // HTTP, scripts, forms and every other remote resource remain blocked.
  const allowRemoteImages = true;
  const [frameReady, setFrameReady] = useState(false);
  const appliedCidSignatureRef = useRef("");
  const cidRafRef = useRef<number | null>(null);
  const readyRafRef = useRef<number | null>(null);

  useEffect(() => {
    mailPerf("iframe-created", { count: 1 });
  }, []);

  useEffect(() => {
    setHeight(60);
  }, [html]);

  const parentOrigin = useMemo(
    () => (typeof window !== "undefined" ? window.location.origin : "null"),
    [],
  );

  const srcDoc = useMemo(
    () =>
      buildEmailSrcDoc({
        html,
        nonce,
        channelId,
        messageIdentity,
        generation,
        parentOrigin,
        allowRemoteImages,
      }),
    [html, nonce, channelId, messageIdentity, generation, parentOrigin, allowRemoteImages],
  );

  useEffect(() => {
    setFrameReady(false);
    appliedCidSignatureRef.current = "";
    if (readyRafRef.current !== null) cancelAnimationFrame(readyRafRef.current);
    readyRafRef.current = null;
  }, [srcDoc]);

  useEffect(
    () => () => {
      if (readyRafRef.current !== null) cancelAnimationFrame(readyRafRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!frameReady || cidImages.length === 0 || !ref.current?.contentWindow) return;
    const safeImages = cidImages.filter((image) => isAllowedInlineImageDataUri(image.dataUri));
    const signature = `${safeImages.length}:${safeImages.reduce(
      (sum, image) => sum + image.dataUri.length,
      0,
    )}`;
    if (signature === appliedCidSignatureRef.current) return;
    const payload = {
      __mm: "cid" as const,
      channel: channelId,
      messageIdentity,
      generation,
      images: safeImages,
    };
    if (!isValidCidApplyPayload(payload, channelId, messageIdentity, generation)) return;
    appliedCidSignatureRef.current = signature;
    const target = ref.current.contentWindow;
    cidRafRef.current = requestAnimationFrame(() => {
      cidRafRef.current = null;
      if (ref.current?.contentWindow !== target) return;
      target.postMessage(payload, "*");
      mailPerf("cid-applied", { count: safeImages.length });
    });
    return () => {
      if (cidRafRef.current !== null) cancelAnimationFrame(cidRafRef.current);
      cidRafRef.current = null;
    };
  }, [cidImages, channelId, frameReady, generation, messageIdentity]);

  useEffect(() => {
    if (!largeCidDispatcherRef) return;
    const dispatch = (images: LargeCidByteMapping[]) => {
      const target = ref.current?.contentWindow;
      if (!target || !frameReady || images.length === 0) return;
      const payload = {
        __mm: "cid-large" as const,
        channel: channelId,
        messageIdentity,
        generation,
        images,
      };
      if (!isValidLargeCidApplyPayload(payload, channelId, messageIdentity, generation)) return;
      const byteLength = images.reduce((total, image) => total + image.bytes.byteLength, 0);
      target.postMessage(
        payload,
        "*",
        images.map((image) => image.bytes),
      );
      mailPerf("large-cid-applied", { count: images.length, bytes: byteLength });
    };
    largeCidDispatcherRef.current = dispatch;
    return () => {
      if (largeCidDispatcherRef.current === dispatch) largeCidDispatcherRef.current = null;
    };
  }, [channelId, frameReady, generation, largeCidDispatcherRef, messageIdentity]);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== "null") return;
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      if (!isValidHeightPayload(e.data, channelId)) return;
      const h = (e.data as { h: number }).h;
      setHeight((prev) => (Math.abs(prev - (h + 4)) > 1 ? h + 4 : prev));
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [channelId]);

  return (
    <div className={className}>
      <iframe
        ref={ref}
        title="email-body"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        scrolling="no"
        onLoad={() => {
          setFrameReady(true);
          if (readyRafRef.current !== null) cancelAnimationFrame(readyRafRef.current);
          readyRafRef.current = requestAnimationFrame(() => {
            readyRafRef.current = null;
            onReady?.();
          });
        }}
        style={{ width: "100%", height, border: 0, display: "block", overflow: "hidden" }}
      />
    </div>
  );
}

/**
 * ThreadedEmailBody — renders the newest part of a message on its own and
 * collapses the quoted history behind a "•••" toggle (Gmail behaviour), so a
 * long back-and-forth thread reads as distinct turns instead of one wall.
 */
function ThreadedEmailBody({
  html,
  cidImages,
  messageIdentity,
  className,
  onReady,
  largeCidDispatcherRef,
  afterLatest,
  renderHistory,
  suppressQuoted,
}: {
  html: string;
  cidImages: CidImageMapping[];
  messageIdentity: string;
  className?: string;
  onReady?: () => void;
  largeCidDispatcherRef?: { current: ((images: LargeCidByteMapping[]) => void) | null };
  /** Rendered directly under the newest turn (e.g. its own attachments). */
  afterLatest?: React.ReactNode;
  /**
   * Replaces the quoted-history block once expanded. Receives the quoted
   * fallback so the caller can render it when no real thread rows exist.
   */
  renderHistory?: (quotedFallback: React.ReactNode) => React.ReactNode;
  /**
   * True when the real thread rows are rendered as separate cards, so the
   * inline quoted history must not be duplicated.
   */
  suppressQuoted?: boolean;
}) {
  const { latest, quoted } = useMemo(() => splitQuotedHtml(html), [html]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [html]);

  if (!quoted)
    return (
      <div className={className}>
        <EmailBodyFrame
          html={html}
          cidImages={cidImages}
          messageIdentity={messageIdentity}
          onReady={onReady}
          largeCidDispatcherRef={largeCidDispatcherRef}
        />
        {afterLatest}
      </div>
    );

  if (suppressQuoted)
    return (
      <div className={className}>
        <EmailBodyFrame
          html={latest}
          cidImages={cidImages}
          messageIdentity={`${messageIdentity}:latest`}
          onReady={onReady}
          largeCidDispatcherRef={largeCidDispatcherRef}
        />
        {afterLatest}
      </div>
    );

  return (
    <div className={className}>
      <EmailBodyFrame
        html={latest}
        cidImages={cidImages}
        messageIdentity={`${messageIdentity}:latest`}
        onReady={onReady}
        largeCidDispatcherRef={largeCidDispatcherRef}
      />

      {afterLatest}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          <span className="tracking-widest leading-none">•••</span>
          <span>{expanded ? tr("إخفاء الرسائل السابقة") : tr("عرض الرسائل السابقة")}</span>
        </button>
        {expanded &&
          (renderHistory ? (
            renderHistory(
              <div className="mt-3 rounded-lg border border-border bg-muted/30 ps-3 pe-2 py-2 border-s-2 border-s-primary/40">
                <EmailBodyFrame
                  html={quoted}
                  cidImages={cidImages}
                  messageIdentity={`${messageIdentity}:quoted`}
                />
              </div>,
            )
          ) : (
            <div className="mt-3 rounded-lg border border-border bg-muted/30 ps-3 pe-2 py-2 border-s-2 border-s-primary/40">
              <EmailBodyFrame
                html={quoted}
                cidImages={cidImages}
                messageIdentity={`${messageIdentity}:quoted`}
              />
            </div>
          ))}
      </div>
    </div>
  );
}

type InlineImageFlight = {
  promise: Promise<Awaited<ReturnType<typeof resolveMessageInlineImages>>>;
  controller: AbortController;
};
const inlineImageFlights = new Map<string, InlineImageFlight>();

function abortInlineImageFlights(): void {
  for (const flight of inlineImageFlights.values()) flight.controller.abort();
  inlineImageFlights.clear();
}

async function decodeInlineMappings(images: CidImageMapping[]): Promise<CidImageMapping[]> {
  const decoded = await Promise.all(
    images.map(async (image) => {
      if (!("dataUri" in image)) return image;
      if (!isAllowedInlineImageDataUri(image.dataUri)) return null;
      if (typeof Image === "undefined") return image;
      const candidate = new Image();
      candidate.src = image.dataUri;
      try {
        if (typeof candidate.decode === "function") await candidate.decode();
        else if (!candidate.complete) {
          await new Promise<void>((resolve, reject) => {
            candidate.onload = () => resolve();
            candidate.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
          });
        }
        const width = candidate.naturalWidth;
        const height = candidate.naturalHeight;
        return width > 0 && height > 0 ? { ...image, width, height } : image;
      } catch {
        return null;
      }
    }),
  );
  return decoded.filter(Boolean) as CidImageMapping[];
}

/**
 * Renders cached CID bytes immediately. Missing small bytes use one protected
 * batch; large CID streams start only after the body iframe reports ready.
 */
function useInlineImageMappings(
  message: MailMessage,
  largeReady: boolean,
  onResolved?: (images: NonNullable<MailMessage["inlineImages"]>) => void,
  onLargeCid?: (images: LargeCidByteMapping[]) => void,
): CidImageMapping[] {
  const resolveInlineImages = useMailServerFn(resolveMessageInlineImages);
  const activeSession = getMailSession();
  const identity = parseMessageId(message.id);
  const uidValidity = validUidValidity(message.uidValidity);
  const messageKey = uidValidity
    ? `${activeSession?.company?.id ?? "none"}|${activeSession?.account.id ?? "none"}|${identity?.folder ?? message.folder}|${identity?.uid ?? message.id}|${uidValidity}`
    : "";
  const embedded = useMemo(
    () =>
      (message.inlineImages ?? [])
        .filter((image) => isAllowedInlineImageDataUri(image.dataUri))
        .map((image) => ({ cid: image.cid, dataUri: image.dataUri })),
    [message.inlineImages],
  );
  const inlinePartition = useMemo(
    () =>
      partitionInlineCidParts(
        message.inlineParts ?? [],
        (message.inlineImages ?? []).map((image) => image.cid),
      ),
    [message.inlineImages, message.inlineParts],
  );
  const deferredStreamParts = useMemo(
    () => [...inlinePartition.largeStreamParts, ...inlinePartition.overflowStreamParts],
    [inlinePartition],
  );
  const [resolved, setResolved] = useState<{ key: string; images: CidImageMapping[] }>({
    key: messageKey,
    images: [],
  });
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);

  useEffect(() => {
    let cancelled = false;
    setResolved({ key: messageKey, images: [] });

    void decodeInlineMappings(embedded).then((decoded) => {
      if (cancelled) return;
      setResolved((current) => {
        if (current.key !== messageKey) return current;
        const byCid = new Map(current.images.map((image) => [image.cid.toLowerCase(), image]));
        for (const image of decoded) byCid.set(image.cid.toLowerCase(), image);
        return { key: messageKey, images: [...byCid.values()] };
      });
    });

    const parts = inlinePartition.smallBatchParts;
    if (!parts.length || !messageKey) {
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      const session = getMailSession();
      const parsed = parseMessageId(message.id);
      if (!session || !parsed) return;

      let entry = inlineImageFlights.get(messageKey);
      if (!entry) {
        mailPerf("cid-request-start", { count: parts.length });
        const controller = new AbortController();
        const promise = resolveInlineImages({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder: parsed.folder,
            uid: parsed.uid,
            uidValidity: uidValidity!,
            parts,
            persist: true,
          },
          signal: controller.signal,
        }).finally(() => {
          if (inlineImageFlights.get(messageKey)?.promise === promise) {
            inlineImageFlights.delete(messageKey);
          }
        });
        entry = { promise, controller };
        inlineImageFlights.set(messageKey, entry);
      }
      let result: Awaited<ReturnType<typeof resolveMessageInlineImages>>;
      try {
        result = await entry.promise;
      } catch {
        return;
      }
      if (!result.ok || cancelled) return;
      const decoded = await decodeInlineMappings(
        result.images.map((image) => ({ cid: image.cid, dataUri: image.dataUri })),
      );
      if (cancelled || decoded.length === 0) return;
      mailPerf("cid-decoded", { count: decoded.length, failed: result.failedCids.length });
      const decodedCids = new Set(decoded.map((image) => image.cid.toLowerCase()));
      const stored = result.images.filter((image) => decodedCids.has(image.cid.toLowerCase()));
      setResolved((current) => {
        if (current.key !== messageKey) return current;
        const byCid = new Map(current.images.map((image) => [image.cid.toLowerCase(), image]));
        for (const image of decoded) byCid.set(image.cid.toLowerCase(), image);
        return { key: messageKey, images: [...byCid.values()] };
      });
      onResolvedRef.current?.(stored);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    embedded,
    message.id,
    message.inlineImages,
    messageKey,
    inlinePartition.smallBatchParts,
    resolveInlineImages,
    uidValidity,
  ]);

  useEffect(() => {
    if (!largeReady || !messageKey) return;
    const session = getMailSession();
    const parsed = parseMessageId(message.id);
    if (!session?.mailSessionToken || !parsed) return;
    const parts = deferredStreamParts;
    if (parts.length === 0) return;
    const cached = readLargeInlineCidSessionCache(messageKey, parts);
    if (cached.misses.length === 0) {
      if (cached.hits.length) onLargeCid?.(cached.hits);
      return;
    }

    const controller = new AbortController();
    if (cached.hits.length) onLargeCid?.(cached.hits);
    // Keep every authenticated request inside both the five-part and 25-MiB
    // ceilings. Fetch sequentially after text paint so a message with 20-50
    // images is progressive, bounded and never delays opening or competes in
    // parallel.
    void (async () => {
      for (const batch of chunkInlineCidParts(cached.misses)) {
        if (controller.signal.aborted) return;
        const mappings = await fetchInlineCidPartsBatch(batch, {
          signal: controller.signal,
          fetchBatch: (requested, signal) =>
            fetch("/api/mail-inline-part", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mailSessionToken: session.mailSessionToken,
                password: session.password,
                folder: parsed.folder,
                uid: parsed.uid,
                uidValidity,
                parts: requested,
              }),
              signal,
            }),
        });
        if (controller.signal.aborted) return;
        if (mappings.length) {
          storeLargeInlineCidSessionCache(messageKey, batch, mappings);
          onLargeCid?.(mappings);
          mailPerf("large-cid-applied", {
            count: mappings.length,
            bytes: mappings.reduce((total, mapping) => total + mapping.bytes.byteLength, 0),
          });
        }
      }
    })().catch(() => undefined);

    return () => {
      controller.abort();
    };
  }, [deferredStreamParts, largeReady, message.id, messageKey, onLargeCid, uidValidity]);

  return resolved.key === messageKey ? resolved.images : [];
}

/** Body renderer that first resolves any deferred inline images. */
function MessageBody({
  message,
  html,
  onInlineImages,
  onEntireBody,
  className,
  afterLatest,
  renderHistory,
  suppressQuoted,
}: {
  message: MailMessage;
  html: string;
  onInlineImages?: (images: NonNullable<MailMessage["inlineImages"]>) => void;
  onEntireBody?: (message: MailMessage) => void;
  className?: string;
  afterLatest?: React.ReactNode;
  renderHistory?: (quotedFallback: React.ReactNode) => React.ReactNode;
  suppressQuoted?: boolean;
}) {
  const bodyIdentity = `${message.id}|${message.uidValidity ?? ""}`;
  const sanitizedHtml = useMemo(() => {
    void bodyIdentity;
    return sanitizeEmailHtml(html);
  }, [bodyIdentity, html]);
  const [readyIdentity, setReadyIdentity] = useState("");
  const largeCidDispatcherRef = useRef<((images: LargeCidByteMapping[]) => void) | null>(null);
  const dispatchLargeCid = useCallback((images: LargeCidByteMapping[]) => {
    largeCidDispatcherRef.current?.(images);
  }, []);
  const cidImages = useInlineImageMappings(
    message,
    readyIdentity === bodyIdentity,
    onInlineImages,
    dispatchLargeCid,
  );
  return (
    <>
      {message.bodyTruncated && (
        <TruncatedBodyWarning message={message} className={className} onLoaded={onEntireBody} />
      )}
      <ThreadedEmailBody
        html={sanitizedHtml}
        cidImages={cidImages}
        messageIdentity={bodyIdentity}
        className={message.bodyTruncated ? undefined : className}
        onReady={() => setReadyIdentity(bodyIdentity)}
        largeCidDispatcherRef={largeCidDispatcherRef}
        afterLatest={afterLatest}
        renderHistory={renderHistory}
        suppressQuoted={suppressQuoted}
      />
    </>
  );
}

function TruncatedBodyWarning({
  message,
  className,
  onLoaded,
}: {
  message: MailMessage;
  className?: string;
  onLoaded?: (message: MailMessage) => void;
}) {
  const openEntire = useMailServerFn(openEntireMailMessage);
  const [loading, setLoading] = useState(false);
  const identity = `${message.id}|${message.uidValidity ?? ""}`;
  const activeIdentityRef = useRef(identity);
  const mountedRef = useRef(true);
  activeIdentityRef.current = identity;
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  async function loadEntire() {
    if (loading) return;
    const parsed = parseMessageId(message.id);
    const session = getMailSession();
    if (!parsed || !session?.mailSessionToken || !message.uidValidity) {
      toast.error(tr("تعذر تحميل الرسالة كاملة. حاول مرة أخرى."));
      return;
    }
    const requestIdentity = identity;
    const companyId = session.company?.id ?? session.account.company_id;
    const key = `${companyId}|${session.account.id}|${parsed.folder}|${parsed.uid}|${message.uidValidity}`;
    setLoading(true);
    try {
      const result = await runEntireMessageSingleFlight(key, () =>
        openEntire({
          data: {
            mailSessionToken: session.mailSessionToken!,
            password: session.password,
            folder: parsed.folder,
            uid: parsed.uid,
            uidValidity: message.uidValidity!,
          },
        }),
      );
      if (!mountedRef.current || activeIdentityRef.current !== requestIdentity) return;
      if (!result.ok) {
        toast.error(
          tr(
            result.code === "MESSAGE_BODY_TOO_LARGE"
              ? "هذه الرسالة كبيرة جدًا لعرضها كاملة بأمان."
              : "تعذر تحميل الرسالة كاملة. حاول مرة أخرى.",
          ),
        );
        return;
      }
      onLoaded?.({
        ...message,
        body: result.body,
        bodyTruncated: undefined,
        inlineParts: result.inlineParts,
        inlineImages: [],
        uidValidity: result.uidValidity,
      });
    } catch {
      if (mountedRef.current && activeIdentityRef.current === requestIdentity) {
        toast.error(tr("تعذر تحميل الرسالة كاملة. حاول مرة أخرى."));
      }
    } finally {
      if (mountedRef.current && activeIdentityRef.current === requestIdentity) setLoading(false);
    }
  }

  return (
    <div
      role="status"
      className={cn(
        className,
        "mb-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/70 dark:bg-amber-950/40 dark:text-amber-200",
      )}
    >
      <div>{tr("هذه الرسالة كبيرة جدًا. يتم عرض جزء فقط من محتواها.")}</div>
      <button
        type="button"
        disabled={loading}
        onClick={loadEntire}
        className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-amber-400/70 bg-background/70 px-2 py-1 font-medium hover:bg-background disabled:cursor-wait disabled:opacity-70"
      >
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {tr(loading ? "جاري تحميل الرسالة كاملة…" : "عرض الرسالة كاملة")}
      </button>
    </div>
  );
}

import {
  Inbox,
  Star,
  Send,
  FileText,
  Trash2,
  Archive,
  AlertOctagon,
  Search,
  Menu,
  X,
  Pencil,
  Paperclip,
  RefreshCw,
  MoreVertical,
  MoreHorizontal,
  LogOut,
  Mail as MailIcon,
  Loader2,
  ChevronDown,
  Reply,
  ReplyAll,
  Forward,
  Printer,
  MailOpen,
  Copy,
  ShieldCheck,
  ShieldAlert,
  CheckSquare,
  Square,
  MinusSquare,
  ArchiveRestore,
  Zap,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Subscript,
  Superscript,
  List,
  ListOrdered,
  Link2,
  Type,
  Quote,
  Eraser,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Indent,
  Outdent,
  Undo2,
  Redo2,
  Minus,
  Image as ImageIcon,
  Palette,
  Highlighter,
  ArrowLeftRight,
  AlertTriangle,
  Globe,
  Check,
  ArrowUpDown,
  Download,
  CircleArrowDown,
  Eye,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  FileCode,
  FileType,
  History,
  Folder as FolderIcon,
  FolderPlus,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MailSignatureButton } from "@/components/mail-signature-button";
import { insertSignatureIntoEditor, SIGNATURE_CLASS } from "@/lib/mail-signature";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-provider";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCompanyTheme } from "@/hooks/use-company-theme";
import {
  bridgeGetFolderCounts,
  bridgeGetMessages,
  bridgeMarkRead,
  bridgeStar,
  bridgeMove,
  bridgeDelete,
  bridgeSearch,
  bridgeGetSenderMessagesPage,
  type SenderMessagesCursor,
  bridgeDeleteDraft,
} from "@/lib/mail-bridge.functions";
import {
  openEntireMailMessage,
  openMailMessage,
  prefetchMessageWindow,
  resolveMessageInlineImages,
} from "@/lib/mail-message-open.functions";
import { listMailConversation, type ConversationRow } from "@/lib/mail-conversation.functions";
import { prepareConversationHistory } from "@/lib/mail-conversation-history";
import {
  readDraftDoc,
  readDraftDocById,
  writeDraftDoc,
  updateDraftDocServerRef,
  confirmDraftDocRemoteCommit,
  clearDraftDoc,
  shouldFinalizeCleanClose,
  isCleanRemoteDraft,
  shouldCloseAfterUploadWait,
  createDraftSaver,
  createPendingDeleteQueue,
  deleteDraftAfterSend,
  newDraftId,
  type DraftSaver,
  type DraftSaveStatus,
  type DraftServerRef,
  type DraftSnapshot,
  type DraftRecipient,
  type DraftDocV3,
  type PendingDeleteQueue,
} from "@/lib/mail-draft-lifecycle";
import { DRAFT_REMOTE_IDLE_MS, DRAFT_MAX_DIRTY_MS } from "@/lib/mail-draft-autosave-policy";
import type {
  WorkingDraftAttachmentReference,
  WorkingDraftPayload,
  WorkingDraftRecord,
  WorkingDraftSentRef,
} from "@/lib/mail-working-draft";
import {
  findWorkingDraftIdByServerRef,
  isSentProviderDraftRef,
  isStaleProviderDraftRow,
} from "@/lib/mail-working-draft";
import {
  createAutosaveScheduler,
  attachInputListener,
  attachBeforeUnloadGuard,
  isDraftEmpty,
  attachmentSetSignature,
  decideAttachmentSizeBlock,
  createRequestBoundSignatureStore,
  canStartRemoteAutosave,
  canScheduleWorkingDraftCheckpoint,
  mutateEditorWithSingleInput,
  type RequestBoundSignatureStore,
} from "@/lib/mail-composer-autosave";
import { createDraftAutosaveRefreshTracker } from "@/lib/mail-autosave-refresh";
import {
  MessageMemoryCache,
  validUidValidity,
  type MessageCacheScope,
} from "@/lib/mail-message-memory-cache";
import {
  AdaptivePrefetchQueue,
  adjacentPrefetchIds,
  firstVisiblePrefetchIds,
  shouldUseWidePrefetch,
  cancelScheduledPrefetch,
  abortInflightControllers,
  type PrefetchPriority,
} from "@/lib/mail-prefetch";
import {
  MessageOpenIntentGeneration,
  NavigationGeneration,
  type MessageOpenIntent,
} from "@/lib/mail-navigation-race";
import { mailPerf } from "@/lib/mail-performance";
import {
  applyDraftDeleteOptimistic,
  deleteSavedDraft,
  rollbackDraftDeleteOptimistic,
  shouldShowDeleteDraft,
} from "@/lib/mail-composer-delete-draft";
import { tombstoneGhostMessage } from "@/lib/mail-ghost-cleanup.functions";
import { indexListMessages } from "@/lib/mail-index.functions";
import {
  listSenderFolders,
  listSenderMessages,
  mergeSenderMessagePages,
  saveSenderFolder,
  deleteSenderFolder,
  type SenderFolder,
} from "@/lib/mail-sender-folders.functions";
import { SenderFolderDialog } from "@/components/sender-folder-dialog";
import { senderFolderColor } from "@/lib/mail-sender-folder-colors";
import { indexListFolderCounts, type IndexFolderCount } from "@/lib/mail-index-counts.functions";
import { resolveSyncPath } from "@/lib/mail-sync-path";
import {
  createSavedDraftGuard,
  type SavedDraftGuard,
  type SavedDraftIdentity,
} from "@/lib/mail-saved-draft-guard";
import type {
  DraftSaveTriggerDiagnostics,
  DraftSaveTriggerReason,
} from "@/lib/mail-draft-save-diagnostics";
import { decidePreNetworkDraftOpen, decideSettledDraftFetch } from "@/lib/mail-stale-draft-open";
import { DraftEngine } from "@/lib/mail-draft-engine";
import {
  chooseDraftOpenTarget,
  draftSendNeedsWorkingDraftPersist,
  isDraftEditComposeInitial,
  shouldUseLocalIndexForFolder,
} from "@/lib/mail-draft-open-orchestration";
import {
  activateDraftCountGuard,
  clearDraftCountGuard,
  createDraftCountGuard,
  hydrateFolderCount,
  reconcileDraftCountGuardCleanup,
  syncDraftCountGuardTotal,
} from "@/lib/mail-draft-count-guard";
import {
  DRAFT_PROVIDER_CHECKPOINT_CADENCE_MS,
  shouldRunProviderCheckpoint,
} from "@/lib/mail-draft-provider-checkpoint";
import { indexUpdateFlag } from "@/lib/mail-flags.functions";
import { indexMoveMessage } from "@/lib/mail-move.functions";
import { indexDeleteMessage } from "@/lib/mail-delete.functions";
import { MAIL_INDEX_ENABLED } from "@/lib/mail-feature-flags";

import { useMailIndexSync } from "@/hooks/use-mail-index-sync";
import {
  applyOverrides as applyFlagOverrides,
  applyOverrideToOne as applyFlagOverrideToOne,
  applyHidden as applyHiddenIds,
  clearOverride as clearFlagOverride,
  clearOverrideField as clearFlagOverrideField,
  confirmHide,
  gcHiddenBefore,
  hideId,
  reconcileOverrides as reconcileFlagOverrides,
  setOverride as setFlagOverride,
  unhideId,
  type HiddenIdsSet,
  type OverridesMap as FlagOverridesMap,
} from "@/lib/mail-pending-overrides";

import { runManualRefresh } from "@/lib/mail-refresh-orchestration";
import { runMailSync } from "@/lib/mail-sync.functions";
import {
  coordinateSentCopyCompletion,
  createSentSyncCoalescer,
  runTargetedSentSync,
  watchSentCopy,
  type SentCopyState,
} from "@/lib/mail-sent-copy-coordinator";
import { createSingleFlight } from "@/lib/single-flight";
import { reviveAt } from "@/lib/mail-rollback";

import {
  formatDate,
  formatSize,
  getFolderCounts as getMockFolderCounts,
  getMessages as getMockMessages,
  getMessage as getMockMessage,
} from "@/lib/mail-mock";
import type { MailFolder, MailMessage } from "@/lib/mail-types";
import { buildEmailHtmlDocument, htmlToPlainText } from "@/lib/mail-compose-html";
import {
  createInlineComposeImage,
  createSourceInlineComposeImage,
  INLINE_IMAGE_MAX_BYTES,
  dataUriToFile,
  hydrateInlineComposeImage,
  hydrateSourceInlineComposeImage,
  insertInlineImageNode,
  serializeInlineImages,
  metadataToTransport,
  toInlineImageMetadata,
  validateInlineImageFile,
  clampInlineImageWidth,
  removeInlineImageNode,
  alignInlineImageNode,
  installInlineImageSelectionListener,
  startInlineImageDragSession,
  applyInlineImageToCidNodes,
  mergeHydratedInlineImages,
  type InlineComposeImage,
  type InlineImageAlignment,
  type InlineImageDragSession,
  type InlineImageMime,
} from "@/lib/mail-compose-inline-images";
import {
  clearDraftTransportCache,
  readDraftTransportCache,
  writeDraftTransportCache,
} from "@/lib/mail-draft-transport-cache";
import {
  clearInlineImages,
  deleteInlineImage,
  inlineImageScope,
  persistInlineImage,
  readInlineImages,
} from "@/lib/mail-compose-inline-store.browser";

import { clearMailSession, getMailSession, type MailSession } from "@/lib/mail-session";
import { MailboxSwitcher } from "@/components/mailbox-switcher";

import { useMailServerFn, useMailSessionRenewal } from "@/hooks/use-mail-session-renewal";
import {
  hydrateContactSuggestions,
  recordSentRecipients,
  hideContactSuggestion,
} from "@/lib/mail-contact-suggestions.functions";
import {
  ensureScopeReady,
  searchLocal,
  recordLocalSend,
  forgetLocal,
  wipeAllPersisted,
  clearMemoryCache,
  type AutocompleteMatch,
} from "@/lib/mail-contact-suggestions.browser";
import {
  applyPendingMoveOverlay,
  beginPendingMove as beginPendingMoveEntry,
  clearPendingMovesForAccount,
  confirmPendingMove as confirmPendingMoveEntry,
  isMessageSuppressed,
  loadPendingMovesFromSession,
  normalizePhysicalFolder,
  reconcilePendingMovesAfterSourceRead,
  rollbackPendingMove as rollbackPendingMoveEntry,
  savePendingMovesToSession,
  type PendingMoveOperation,
  type PendingMovesMap,
} from "@/lib/mail-pending-moves";

import {
  rememberFinalOrigin,
  rememberPendingOrigin,
  getOrigin as trackerGetOrigin,
  forgetFinalOrigin,
  forgetPendingOrigin,
  purgeStaleTrashUidValidity,
  clearAccountOrigins,
  buildOriginFingerprint,
  promoteUniquePendingOriginForTrashMessage,
  type OriginKind,
} from "@/lib/mail-origin-tracker";
import type { IndexMoveResult } from "@/lib/mail-move.functions";

export const Route = createFileRoute("/mail")({
  ssr: false,
  head: () => ({
    meta: [{ title: "صندوق الوارد — MailMaestro" }],
  }),
  component: MailApp,
});

// Labels are natural-language keys (Arabic). Wrap with tr() at render.
const FOLDER_META: Record<MailFolder, { label: string; icon: typeof Inbox }> = {
  inbox: { label: "الوارد", icon: Inbox },
  starred: { label: "المميّزة", icon: Star },
  sent: { label: "المرسلة", icon: Send },
  drafts: { label: "المسودّات", icon: FileText },
  spam: { label: "المزعجة", icon: AlertOctagon },
  trash: { label: "المهملات", icon: Trash2 },
  archive: { label: "الأرشيف", icon: Archive },
  all: { label: "الكل", icon: MailIcon },
};

function parseMessageId(id: string): { folder: MailFolder; uid: number } | null {
  const [folder, uidStr] = id.split(":");
  const uid = Number(uidStr);
  if (!folder || !uidStr || Number.isNaN(uid)) return null;
  return { folder: folder as MailFolder, uid };
}

// ---- Trash origin tracking (BLOCKER_C — trash identity v3) ----
// Origin is keyed by the PHYSICAL trash identity `(accountId, trashUidValidity,
// trashUid)`, never by threadId. On failure to obtain the trash identity from
// Bridge UIDPLUS / Targeted Discovery, a pending origin is stored keyed by
// the source identity and later promoted when the trash identity becomes
// known via a background sync.
function safeOriginStorage() {
  if (typeof localStorage === "undefined") {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
  return localStorage;
}

/** Extract trash identity from a successful move result, if available. */
function extractTrashIdentity(
  result: IndexMoveResult | null,
): { trashUidValidity: number; trashUid: number } | null {
  if (!result || !result.ok) return null;
  // Prefer Bridge UIDPLUS mapping.
  if (
    result.move.uidMappingAvailable &&
    typeof result.move.destinationUid === "number" &&
    result.move.destinationUidValidity
  ) {
    const uv = Number(result.move.destinationUidValidity);
    if (Number.isFinite(uv) && uv > 0) {
      return { trashUidValidity: uv, trashUid: result.move.destinationUid };
    }
  }
  // Fall back to Targeted Destination Sync discovery.
  if (typeof result.discoveredDestinationUid === "number") {
    const uv = result.discoveredDestinationUidValidity
      ? Number(result.discoveredDestinationUidValidity)
      : NaN;
    if (Number.isFinite(uv) && uv > 0) {
      return { trashUidValidity: uv, trashUid: result.discoveredDestinationUid };
    }
  }
  return null;
}

/** Build a fingerprint from a MailMessage-like row. */
function fingerprintFromMessage(m: {
  threadId?: string | null;
  from?: { email?: string | null } | null;
  subject?: string | null;
  date?: string | null;
}): string {
  return buildOriginFingerprint({
    messageId: m.threadId ?? null,
    fromEmail: m.from?.email ?? null,
    subject: m.subject ?? null,
    date: m.date ?? null,
  });
}

/**
 * Return the OriginKind we track when the destination is `dest`, or null
 * for destinations that have no restore semantics (inbox/sent/drafts/spam/all).
 */
function originKindForDestination(dest: MailFolder): OriginKind | null {
  if (dest === "trash") return "trash";
  if (dest === "archive") return "archive";
  return null;
}

/** Return the OriginKind for a source folder that CAN be restored. */
function originKindForRestore(source: MailFolder): OriginKind | null {
  if (source === "trash") return "trash";
  if (source === "archive") return "archive";
  return null;
}

/**
 * Write origin after a successful move to Trash OR Archive (final or pending).
 * `destKind` scopes the namespace so Trash and Archive origins can never
 * collide even when both destinations expose the same (UID, UIDVALIDITY).
 */
function writeOriginOnDestination(params: {
  accountId: string | null;
  destKind: OriginKind;
  sourceCanonical: MailFolder;
  sourceUid: number;
  sourceUidValidity?: number;
  messageId?: string | null;
  fingerprint?: string | null;
  moveResult: IndexMoveResult | null;
}) {
  const {
    accountId,
    destKind,
    sourceCanonical,
    sourceUid,
    sourceUidValidity,
    messageId,
    fingerprint,
    moveResult,
  } = params;
  // Guard: never remember an origin whose "source" equals the destination
  // kind itself (would encode "restore back to trash/archive" — nonsense).
  if (!accountId || sourceCanonical === destKind) return;
  const storage = safeOriginStorage();
  const dest = extractTrashIdentity(moveResult);
  if (dest) {
    rememberFinalOrigin(
      storage,
      { accountId, trashUidValidity: dest.trashUidValidity, trashUid: dest.trashUid },
      { originalCanonical: sourceCanonical, messageId: messageId ?? null },
      destKind,
    );
    forgetPendingOrigin(
      storage,
      { accountId, sourceCanonical, sourceUid, sourceUidValidity },
      destKind,
    );
  } else {
    rememberPendingOrigin(
      storage,
      { accountId, sourceCanonical, sourceUid, sourceUidValidity },
      {
        originalCanonical: sourceCanonical,
        messageId: messageId ?? null,
        fingerprint: fingerprint ?? null,
        createdAt: Date.now(),
      },
      destKind,
    );
  }
}

/** Read the origin for a destination uid (Trash or Archive). Defaults to "inbox". */
function readOriginForDestUid(
  kind: OriginKind,
  accountId: string | null,
  destUid: number,
  destUidValidity: number | null,
): MailFolder {
  if (!accountId || destUidValidity == null) return "inbox";
  const hit = trackerGetOrigin(
    safeOriginStorage(),
    { accountId, trashUidValidity: destUidValidity, trashUid: destUid },
    kind,
  );
  return (hit?.originalCanonical as MailFolder) ?? "inbox";
}

/**
 * Forget the FINAL origin entry for one physical destination row (Trash or
 * Archive). Never touches other entries and never touches Pending entries.
 */
function forgetOriginForDestUid(
  kind: OriginKind,
  accountId: string | null,
  destUid: number,
  destUidValidity: number | null,
) {
  if (!accountId || destUidValidity == null) return;
  forgetFinalOrigin(
    safeOriginStorage(),
    { accountId, trashUidValidity: destUidValidity, trashUid: destUid },
    kind,
  );
}

/** Drop the exact pending origin entry for an exact source identity. */
function forgetExactPendingOrigin(
  accountId: string | null,
  kind: OriginKind,
  sourceCanonical: MailFolder,
  sourceUid: number,
  sourceUidValidity?: number,
) {
  if (!accountId) return;
  forgetPendingOrigin(
    safeOriginStorage(),
    { accountId, sourceCanonical, sourceUid, sourceUidValidity },
    kind,
  );
}

/**
 * After a destination list arrives (from Index or Bridge), promote any
 * UNIQUE pending origin whose fingerprint matches a newly-visible row in
 * that destination. Ambiguous matches are ignored.
 */
function promotePendingOriginsForDestList(
  kind: OriginKind,
  accountId: string | null,
  destUidValidity: number | null,
  messages: ReadonlyArray<MailMessage>,
) {
  if (!accountId || destUidValidity == null) return;
  const storage = safeOriginStorage();
  for (const m of messages) {
    const parsed = parseMessageId(m.id);
    if (!parsed || parsed.folder !== kind) continue;
    const fp = fingerprintFromMessage(m);
    if (!fp) continue;
    promoteUniquePendingOriginForTrashMessage(
      storage,
      {
        accountId,
        trashUidValidity: destUidValidity,
        trashUid: parsed.uid,
        fingerprint: fp,
      },
      kind,
    );
  }
}

type EditDraftSource = {
  /** MailMessage.id in "folder:uid" form; used to fetch attachment bytes. */
  messageId: string;
  attachments: import("@/lib/mail-types").MailAttachment[];
};

type ComposeInitial = {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  direction?: "rtl" | "ltr";
  showCc?: boolean;
  showBcc?: boolean;
  /**
   * Edit-Draft mode: when set, the composer opens as an EDIT of an existing
   * server-side draft. draftId reuses the sticky X-MailMaestro-Draft-ID when
   * present (legacy drafts fall back to a fresh uuid + previousRef so the
   * bridge can atomically APPEND-then-delete the legacy copy — M4-A).
   */
  editDraftId?: string;
  previousRef?: DraftServerRef;
  /** Physical source of kept IMAP attachments; never implies Draft replacement. */
  attachmentSourceRef?: AttachmentSourceRef;
  existingAttachments?: EditDraftSource;
  /** When true, `body` is already sanitized HTML and is loaded verbatim. */
  bodyIsHtml?: boolean;
  inlineParts?: NonNullable<MailMessage["inlineParts"]>;
  inlineImages?: NonNullable<MailMessage["inlineImages"]>;
  inlineMessageId?: string;
  inlineUidValidity?: string;
  /** Hardened source retained briefly for post-paint quote style isolation. */
  quoteSourceHtml?: string;
  /** RFC threading headers used only for Reply/Reply All, never Forward. */
  inReplyTo?: string;
  references?: string[];
};

/** Opens an authoritative server Working Draft without waiting for IMAP list/index visibility. */
function buildWorkingDraftInitial(record: WorkingDraftRecord): ComposeInitial {
  const snapshot = record.payload.snapshot;
  const addressText = (items: readonly DraftRecipient[] | undefined) =>
    (items ?? [])
      .filter((item) => item.valid !== false)
      .map((item) => (item.name ? `${item.name} <${item.email}>` : item.email))
      .join(", ");
  return {
    to: addressText(snapshot.to),
    cc: addressText(snapshot.cc),
    bcc: addressText(snapshot.bcc),
    body: snapshot.html,
    direction: snapshot.dir,
    subject: snapshot.subject || "",
    bodyIsHtml: true,
    showCc: Boolean(snapshot.showCc),
    showBcc: Boolean(snapshot.showBcc),
    editDraftId: record.draftId,
    inReplyTo: snapshot.inReplyTo,
    references: snapshot.references,
  };
}

function stripHtml(html: string): string {
  if (!html) return "";
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "");
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function buildReply(
  message: MailMessage,
  myEmail: string,
  all: boolean,
  attachmentSourceRef?: AttachmentSourceRef | null,
): ComposeInitial {
  const subject = replySubject(message.subject);
  const recipients = buildReplyRecipients(message, myEmail, all);
  const to = recipients.to.map(formatComposeAddress).filter(Boolean).join(", ");
  const cc = recipients.cc.map(formatComposeAddress).filter(Boolean).join(", ");
  const threading = buildThreadingHeaders(message.references, message.threadId);
  const quoteSourceHtml = sanitizeEmailHtml(message.body || message.preview || "");
  const body = markQuotedCidImagesPending(
    buildReplyQuoteHtml(
      quoteSourceHtml,
      { from: message.from, date: message.date },
      getCurrentLang(),
      tr("كتب:"),
    ),
  );
  return {
    to,
    cc,
    subject,
    body,
    bodyIsHtml: true,
    inlineParts: message.inlineParts,
    inlineImages: message.inlineImages,
    inlineMessageId: message.id,
    inlineUidValidity: message.uidValidity,
    attachmentSourceRef: attachmentSourceRef ?? undefined,
    quoteSourceHtml,
    ...threading,
  };
}

function buildForward(
  message: MailMessage,
  attachmentSourceRef: AttachmentSourceRef | null,
): ComposeInitial | null {
  const normalAttachments = selectNormalComposerAttachments(message);
  if (normalAttachments.length > 0 && !attachmentSourceRef) return null;
  const subject = forwardSubject(message.subject);
  const quoteSourceHtml = sanitizeEmailHtml(message.body || message.preview || "");
  const body = markQuotedCidImagesPending(
    buildForwardQuoteHtml(
      quoteSourceHtml,
      {
        from: message.from,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        date: message.date,
      },
      getCurrentLang(),
      {
        header: `---------- ${tr("رسالة معاد توجيهها")} ----------`,
        from: `${tr("من:")}`,
        date: `${tr("التاريخ:")}`,
        subject: `${tr("الموضوع:")}`,
        to: `${tr("إلى:")}`,
        cc: `${tr("نسخة:")}`,
      },
    ),
  );
  return {
    to: "",
    subject,
    body,
    bodyIsHtml: true,
    inlineParts: message.inlineParts,
    inlineImages: message.inlineImages,
    inlineMessageId: message.id,
    inlineUidValidity: message.uidValidity,
    quoteSourceHtml,
    attachmentSourceRef: attachmentSourceRef ?? undefined,
    existingAttachments:
      normalAttachments.length > 0
        ? { messageId: message.id, attachments: normalAttachments }
        : undefined,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build an Edit-Draft ComposeInitial from a fetched Drafts folder message.
 * When `message.draftIdHeader` is a valid uuid we reuse it (idempotency wins);
 * otherwise we allocate a fresh id and rely on `previousRef` to let the
 * bridge atomically APPEND-then-delete the legacy copy (M4-A contract).
 */
function buildEditDraft(message: MailMessage, draftsFolderPath?: string): ComposeInitial {
  const to = (message.to ?? [])
    .map((a) => a.email)
    .filter(Boolean)
    .join(", ");
  const cc = (message.cc ?? [])
    .map((a) => a.email)
    .filter(Boolean)
    .join(", ");
  const headerId = message.draftIdHeader?.trim();
  const editDraftId = headerId && UUID_RE.test(headerId) ? headerId : newDraftId();
  const parsed = parseMessageId(message.id);
  const previousRef: DraftServerRef | undefined =
    parsed && draftsFolderPath && message.uidValidity
      ? {
          folderPath: draftsFolderPath,
          uid: parsed.uid,
          uidValidity: String(message.uidValidity),
        }
      : undefined;
  const rawSubject = message.subject === tr("(بدون موضوع)") ? "" : message.subject;
  const normalAttachments = selectNormalComposerAttachments(message);
  const existingAttachments =
    normalAttachments.length > 0
      ? { messageId: message.id, attachments: normalAttachments }
      : undefined;
  return {
    to,
    cc,
    subject: rawSubject,
    body: message.body ?? "",
    bodyIsHtml: true,
    showCc: (message.cc ?? []).length > 0,
    showBcc: false,
    editDraftId,
    previousRef,
    attachmentSourceRef: normalAttachments.length > 0 ? previousRef : undefined,
    existingAttachments,
    inlineParts: message.inlineParts,
    inlineImages: message.inlineImages,
    inlineMessageId: message.id,
    inlineUidValidity: message.uidValidity,
    ...buildThreadingHeaders(message.references, message.inReplyTo),
  };
}

type SortOption = "date-desc" | "date-asc" | "unread-first" | "starred-first";

type SourceKind = "index" | "bridge" | "mock";

type PostSendInfo = {
  messageId?: string;
  sentCopySaved: boolean;
  sentCopyPending: boolean;
  sentCopyJobId?: string;
  sentCopyState?: SentCopyState;
  draftOrigin: boolean;
};

// eslint-disable-next-line react-refresh/only-export-components -- executable regression contract
export function isMailListLoadingMore(
  normalLoadingMore: boolean,
  senderScopeKey: string | null,
  senderHistoryLoadingScope: string | null,
): boolean {
  return (
    normalLoadingMore || (senderScopeKey !== null && senderHistoryLoadingScope === senderScopeKey)
  );
}

function useMailData(session: MailSession | null) {
  const getCounts = useMailServerFn(bridgeGetFolderCounts);
  const getMessages = useMailServerFn(bridgeGetMessages);
  const listIndex = useMailServerFn(indexListMessages);
  const listIndexCounts = useMailServerFn(indexListFolderCounts);
  const syncFolder = useMailServerFn(runMailSync);
  const listSender = useMailServerFn(listSenderMessages);
  const getSenderHistoryPage = useMailServerFn(bridgeGetSenderMessagesPage);

  const [folder, setFolder] = useState<MailFolder>("inbox");
  // Sender Folders — virtual filter view over the Inbox index. When set, the
  // list shows only messages from this address; `folder` stays "inbox" so
  // every existing mutation/sync path keeps working unchanged.
  const [senderView, setSenderView] = useState<string | null>(null);
  const listScopeKey = `${session?.account.id ?? ""}|${folder}|${senderView?.trim().toLowerCase() ?? ""}`;
  const listScopeKeyRef = useRef(listScopeKey);
  listScopeKeyRef.current = listScopeKey;
  const loadedListScopeRef = useRef<string | null>(null);
  // Scope all server-search progress to this account + normalized sender.
  const senderScopeKey =
    session && senderView ? `${session.account.id}|${senderView.trim().toLowerCase()}` : null;
  const senderScopeKeyRef = useRef<string | null>(senderScopeKey);
  senderScopeKeyRef.current = senderScopeKey;
  const senderHistoryRef = useRef<{
    scopeKey: string;
    cursor: SenderMessagesCursor | null;
    exhausted: boolean;
  } | null>(null);
  const senderHistoryFlightRef = useRef<string | null>(null);

  const [senderCursor, setSenderCursor] = useState<string | null>(null);
  // Folder definitions: one tiny SELECT per session, never polled.
  const [senderFolders, setSenderFolders] = useState<SenderFolder[]>([]);
  const loadSenderFoldersFn = useMailServerFn(listSenderFolders);
  const saveSenderFolderFn = useMailServerFn(saveSenderFolder);
  const deleteSenderFolderFn = useMailServerFn(deleteSenderFolder);
  const mailToken = session?.mailSessionToken ?? null;
  useEffect(() => {
    if (!mailToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await loadSenderFoldersFn({ data: { mailSessionToken: mailToken } });
        if (!cancelled && res.ok) setSenderFolders(res.folders);
      } catch {
        /* non-fatal: sender folders are an additive convenience */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mailToken, loadSenderFoldersFn]);

  const upsertSenderFolder = useCallback(
    async (draft: { email: string; name: string; color: string }) => {
      if (!mailToken) return false;
      const res = await saveSenderFolderFn({ data: { mailSessionToken: mailToken, ...draft } });
      if (!res.ok) return false;
      const saved = res.folders[0]!;
      setSenderFolders((prev) => {
        const rest = prev.filter((f) => f.email !== saved.email);
        return [...rest, saved];
      });
      return true;
    },
    [mailToken, saveSenderFolderFn],
  );

  const removeSenderFolder = useCallback(
    async (email: string) => {
      if (!mailToken) return false;
      const res = await deleteSenderFolderFn({ data: { mailSessionToken: mailToken, email } });
      if (!res.ok) return false;
      setSenderFolders((prev) => prev.filter((f) => f.email !== email));
      setSenderView((cur) => (cur === email ? null : cur));
      return true;
    },
    [mailToken, deleteSenderFolderFn],
  );
  const [sort, setSort] = useState<SortOption>("date-desc");
  const [counts, setCounts] = useState<
    Record<MailFolder, { total: number; unread: number; supported: boolean }>
  >({
    inbox: { total: 0, unread: 0, supported: true },
    starred: { total: 0, unread: 0, supported: true },
    sent: { total: 0, unread: 0, supported: true },
    drafts: { total: 0, unread: 0, supported: true },
    spam: { total: 0, unread: 0, supported: true },
    trash: { total: 0, unread: 0, supported: true },
    archive: { total: 0, unread: 0, supported: true },
    all: { total: 0, unread: 0, supported: true },
  });
  const [folderPaths, setFolderPaths] = useState<Partial<Record<MailFolder, string>>>({});
  // Authoritative physical paths, populated ONLY from the Bridge folder
  // resolution (SPECIAL-USE/well-known). Never fed from Local Index metadata,
  // which is exactly what production has shown can be corrupted. Only these
  // paths may authorize a canonical self-heal reassignment.
  const [authoritativeFolderPaths, setAuthoritativeFolderPaths] = useState<
    Partial<Record<MailFolder, string>>
  >({});
  // Latest Local Index per-folder counts/paths, captured from `loadCountsFast`.
  // Only these (with a unique, non-ambiguous canonical) may feed an UNTRUSTED
  // sync path. Ambiguous/missing canonicals never yield an index path here.
  const [indexFolderCounts, setIndexFolderCounts] = useState<IndexFolderCount[]>([]);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMoreScope, setLoadingMoreScope] = useState<string | null>(null);
  const loadingMore = loadingMoreScope === listScopeKey;
  const [senderHistoryLoadingScope, setSenderHistoryLoadingScope] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [useMock, setUseMock] = useState(false);
  const [source, setSource] = useState<SourceKind>("bridge");
  const [indexCursor, setIndexCursor] = useState<string | null>(null);
  const currentFolderRef = useRef<MailFolder>(folder);
  currentFolderRef.current = folder;
  // Per-folder "index ready" flag, used to drive the sync hook.
  const [indexReady, setIndexReady] = useState<Partial<Record<MailFolder, boolean>>>({});
  // Race guard: only accept a load result whose id matches the latest request.
  const loadReqIdRef = useRef(0);
  const PAGE = 50;

  // Draft initial-sync gate: background Draft synchronization must not compete
  // with the UI-priority first-page source. Cleared on folder/account change;
  // set true once the visible list has settled (index hit, Bridge fallback
  // applied, or Bridge fallback failed). Non-Draft folders ignore it.
  const [draftListSettled, setDraftListSettled] = useState(false);
  useEffect(() => {
    setDraftListSettled(false);
  }, [folder, session?.account.id]);

  // Pending Flag Overrides — persist optimistic star/read across any
  // server-list arrival (Local Index, Bridge, background sync, pagination,
  // deep search). Entries are cleared on mutation failure (rollback) or
  // when a fresh server row confirms the expected value.
  const pendingOverridesRef = useRef<FlagOverridesMap>(new Map());
  // Optimistic hide set — rows removed by the user (unstar in the "starred"
  // folder) that must NOT be resurrected by a racing sync response.
  const pendingHiddenRef = useRef<HiddenIdsSet>(new Map());
  // BLOCKER_3_PENDING_MOVE_OVERLAY — internal overlay preventing stale rows
  // from resurrecting a moved/deleted/restored source-folder row. Never
  // rendered as a badge/indicator. Cleared ONLY by an actual source-folder
  // read whose request started AFTER `confirmedAt` and where the raw IMAP
  // result no longer contains the source UID. See mail-pending-moves.ts.
  const pendingMovesRef = useRef<PendingMovesMap>(loadPendingMovesFromSession());
  const persistPendingMoves = useCallback(() => {
    savePendingMovesToSession(pendingMovesRef.current);
  }, []);
  // BLOCKER_C — current Trash UIDVALIDITY, refreshed from `loadCountsFast`.
  // Used to (a) purge stale final-origin entries on IMAP UIDVALIDITY change
  // and (b) look up the origin for a Restore action by physical trash id.
  const trashUidValidityRef = useRef<number | null>(null);
  // Same for Archive — enables restore-from-archive alongside restore-from-trash.
  const archiveUidValidityRef = useRef<number | null>(null);

  // Batch A / Fix #1: Monotonic Count Generation Guard.
  // Every optimistic mutation (move, delete, restore, permanent delete, star,
  // read/unread, bulk) bumps `countsMutationGen`. Every counts loader
  // captures the current gen at call start; if the gen has advanced by the
  // time the request resolves, the loader MUST drop its result — a mutation
  // fired mid-flight has already applied a better optimistic value.
  const countsMutationGen = useRef(0);
  const bumpCountsGen = useCallback(() => {
    countsMutationGen.current += 1;
  }, []);

  // V4: Starred-count race guard. `active` = in-flight star mutations;
  // `settledAt` = timestamp of the most recent resolution. While either
  // is "hot" (active > 0 OR within 2s of settledAt), counts loaders must
  // NOT overwrite `starred.total` — a stale server value would clobber
  // the optimistic delta applied by toggleStar.
  const pendingStarMutRef = useRef<{ active: number; settledAt: number }>({
    active: 0,
    settledAt: 0,
  });
  const STAR_COUNT_HOT_MS = 2000;
  const isStarCountHot = useCallback(() => {
    const s = pendingStarMutRef.current;
    return s.active > 0 || Date.now() - s.settledAt < STAR_COUNT_HOT_MS;
  }, []);

  const currentAccountId = session?.account.id ?? null;
  const draftCountGuardRef = useRef(createDraftCountGuard());

  /** Apply overrides + hidden filter + pending-move overlay, GC confirmed entries. */
  const applyPending = useCallback(
    (list: MailMessage[]): MailMessage[] => {
      reconcileFlagOverrides(list, pendingOverridesRef.current);
      const patched = applyFlagOverrides(list, pendingOverridesRef.current);
      const hidden = applyHiddenIds(patched, pendingHiddenRef.current);
      return applyPendingMoveOverlay(hidden, pendingMovesRef.current, currentAccountId);
    },
    [currentAccountId],
  );

  /** Wrap a single incoming message the same way (used by messageCache). */
  const applyPendingOne = useCallback(
    (m: MailMessage): MailMessage => applyFlagOverrideToOne(m, pendingOverridesRef.current),
    [],
  );

  /**
   * Reconcile pending-move entries whose source folder was just read. MUST
   * be called with the RAW (pre-overlay) server list so presence checks are
   * accurate. Only touches (accountId + physical source folder) matching
   * the read scope — a Trash read never GC's an Inbox overlay entry.
   */
  const reconcilePendingMovesForRead = useCallback(
    (rawList: MailMessage[], canonical: MailFolder, startedAt: number) => {
      if (!currentAccountId || pendingMovesRef.current.size === 0) return;
      const removed = reconcilePendingMovesAfterSourceRead(pendingMovesRef.current, {
        accountId: currentAccountId,
        physicalSourceFolder: normalizePhysicalFolder(canonical),
        requestStartedAt: startedAt,
        rawList,
      });
      if (removed > 0) persistPendingMoves();
    },
    [currentAccountId, persistPendingMoves],
  );

  // Session/account boundary: if the account identity changes (login, sign-out,
  // account switch), clear its pending-move entries so a stale entry from a
  // previous account can never suppress a new account's rows.
  const lastAccountIdRef = useRef<string | null>(currentAccountId);
  useEffect(() => {
    const prev = lastAccountIdRef.current;
    lastAccountIdRef.current = currentAccountId;
    if (prev && prev !== currentAccountId) {
      clearPendingMovesForAccount(pendingMovesRef.current, prev);
      persistPendingMoves();
    }
  }, [currentAccountId, persistPendingMoves]);

  const loadCounts = useCallback(async () => {
    if (!session) return;
    // Batch A / Fix #1: capture the mutation generation BEFORE the network
    // round-trip. Any mutation between now and the response makes this
    // result stale — drop it rather than overwrite optimistic counters.
    const gen = countsMutationGen.current;
    try {
      const result = await getCounts({
        data: { mailSessionToken: session.mailSessionToken ?? "", password: session.password },
      });
      if (countsMutationGen.current !== gen) return;
      const map: Record<MailFolder, { total: number; unread: number; supported: boolean }> = {
        inbox: { total: 0, unread: 0, supported: true },
        starred: { total: 0, unread: 0, supported: true },
        sent: { total: 0, unread: 0, supported: true },
        drafts: { total: 0, unread: 0, supported: true },
        spam: { total: 0, unread: 0, supported: true },
        trash: { total: 0, unread: 0, supported: true },
        archive: { total: 0, unread: 0, supported: false },
        all: { total: 0, unread: 0, supported: false },
      };
      if (!result.ok) throw new Error(result.error);
      const paths: Partial<Record<MailFolder, string>> = {};
      result.counts.forEach((c) => {
        map[c.folder] = { total: c.total, unread: c.unread, supported: c.supported !== false };
        if (c.path) paths[c.folder] = c.path;
      });
      setCounts((prev) => {
        if (draftCountGuardRef.current.active) {
          map.drafts = hydrateFolderCount({
            folder: "drafts",
            previous: prev.drafts,
            incoming: map.drafts,
            guardedDraftTotal: draftCountGuardRef.current.total,
          });
        }
        // V4 count race guard: while a star mutation is in flight (or was
        // very recently), keep the optimistic starred.total instead of the
        // possibly-stale server value.
        if (isStarCountHot() && prev.starred) {
          map.starred = { ...map.starred, total: prev.starred.total };
        }
        return map;
      });
      setFolderPaths(paths);
      // This is a Bridge `/api/folders` sweep — authoritative path provenance.
      setAuthoritativeFolderPaths(paths);
      setBridgeError(null);
    } catch (err: unknown) {
      if (countsMutationGen.current !== gen) return;
      setBridgeError(errorMessage(err, tr("فشل الاتصال بخادم البريد")));
      setCounts(
        Object.fromEntries(
          getMockFolderCounts().map((c) => [
            c.folder,
            { total: c.total, unread: c.unread, supported: true },
          ]),
        ) as Record<MailFolder, { total: number; unread: number; supported: boolean }>,
      );
    }
  }, [session, getCounts, isStarCountHot]);

  /**
   * Fast counts path: prefer the Local Mail Index (single Supabase SELECT, no
   * IMAP round-trip). When the index is healthy and non-empty this RETURNS
   * immediately — it does NOT trigger a global /api/folders (getCounts) sweep,
   * so a warm indexed session never opens an IMAP connection just to refresh
   * Starred/path metadata. Falls back to the bridge (`loadCounts`) only when
   * the index has nothing for this account/session yet (first-ever bootstrap).
   */
  const loadCountsFast = useCallback(
    async (options?: { draftIndexSyncSettled?: boolean }) => {
      if (!session) return;
      // Batch A / Fix #1: monotonic guard also applies to the fast (Local
      // Index) path. If a mutation runs between the request and response,
      // the fast result is stale — drop it and DO NOT even fall back to
      // loadCounts (that would race the same way).
      const gen = countsMutationGen.current;
      if (MAIL_INDEX_ENABLED && session.mailSessionToken) {
        try {
          const res = await listIndexCounts({
            data: { mailSessionToken: session.mailSessionToken },
          });
          if (countsMutationGen.current !== gen) return;

          if (res.ok && res.counts.length > 0) {
            // Capture the raw Local Index counts so the sync path resolver can
            // derive a unique, non-ambiguous index path per canonical. Ambiguous
            // or missing canonicals simply yield no index sync path.
            setIndexFolderCounts(res.counts);
            // Deterministic duplicate-canonical handling: a canonical that maps
            // to MORE than one Local Index row is ambiguous (corruption). Its
            // physical path must never be promoted (array order must not decide
            // folderPaths.trash), and its count is left unchanged until the
            // authoritative bridge sweep or a trusted sync reconciles it.
            const canonicalOccurrences = new Map<MailFolder, number>();
            for (const c of res.counts) {
              canonicalOccurrences.set(c.folder, (canonicalOccurrences.get(c.folder) ?? 0) + 1);
            }
            const isAmbiguous = (f: MailFolder) => (canonicalOccurrences.get(f) ?? 0) > 1;
            const draftCountForConvergence = res.counts.find(
              (c) => c.folder === "drafts" && c.hasUidvalidity && !isAmbiguous(c.folder),
            );
            setCounts((prev) => {
              const next = { ...prev };
              for (const c of res.counts) {
                if (!c.hasUidvalidity) continue;
                if (isAmbiguous(c.folder)) continue;
                // V4 count race guard: skip starred.total while a mutation is
                // hot; keep the optimistic value the toggle already applied.
                if (c.folder === "starred" && isStarCountHot() && prev.starred) {
                  const cur = next.starred ?? { total: 0, unread: 0, supported: true };
                  next.starred = {
                    total: prev.starred.total,
                    unread: c.unread,
                    supported: cur.supported,
                  };
                  continue;
                }
                const cur = next[c.folder] ?? { total: 0, unread: 0, supported: true };
                next[c.folder] = hydrateFolderCount({
                  folder: c.folder,
                  previous: c.folder === "drafts" ? prev.drafts : undefined,
                  incoming: { total: c.total, unread: c.unread, supported: cur.supported },
                  guardedDraftTotal:
                    c.folder === "drafts" && draftCountGuardRef.current.active
                      ? draftCountGuardRef.current.total
                      : undefined,
                });
              }
              return next;
            });
            if (
              options?.draftIndexSyncSettled &&
              draftCountGuardRef.current.active &&
              draftCountGuardRef.current.cleanupConfirmed &&
              draftCountGuardRef.current.pendingSentDraftIds.size === 0 &&
              draftCountForConvergence?.total === draftCountGuardRef.current.total
            ) {
              clearDraftCountGuard(draftCountGuardRef.current);
            }
            setFolderPaths((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const c of res.counts) {
                if (isAmbiguous(c.folder)) continue;
                if (c.path && next[c.folder] !== c.path) {
                  next[c.folder] = c.path;
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
            setBridgeError(null);
            // BLOCKER_C — track current Trash UIDVALIDITY. When it changes
            // (server-side UIDVALIDITY reset), purge stale final origins so
            // an unrelated future Trash UID cannot inherit a stale origin.
            const trashCount = res.counts.find((c) => c.folder === "trash");
            const nextTrashUV = trashCount?.uidvalidity ?? null;
            if (
              nextTrashUV != null &&
              trashUidValidityRef.current !== nextTrashUV &&
              currentAccountId
            ) {
              purgeStaleTrashUidValidity(
                safeOriginStorage(),
                currentAccountId,
                nextTrashUV,
                "trash",
              );
            }
            trashUidValidityRef.current = nextTrashUV;
            // Mirror for Archive: capture current Archive UIDVALIDITY so restore
            // from Archive can validate final-origin entries the same way Trash does.
            const archiveCount = res.counts.find((c) => c.folder === "archive");
            const nextArchiveUV = archiveCount?.uidvalidity ?? null;
            if (
              nextArchiveUV != null &&
              archiveUidValidityRef.current !== nextArchiveUV &&
              currentAccountId
            ) {
              purgeStaleTrashUidValidity(
                safeOriginStorage(),
                currentAccountId,
                nextArchiveUV,
                "archive",
              );
            }
            archiveUidValidityRef.current = nextArchiveUV;
            // Healthy Local Index → RETURN. No automatic getCounts / /api/folders
            // sweep here: counts + paths already came from the index, and a warm
            // indexed session must not open a global IMAP connection just to
            // refresh Starred/path metadata. Authoritative path resolution (and a
            // Starred count refresh) is driven separately, only when actually
            // needed (see the targeted resolution below / explicit interactions).
            return;
          }
        } catch {
          /* fall through to bridge */
        }
      }
      await loadCounts();
    },
    [session, listIndexCounts, loadCounts, isStarCountHot],
  );

  // While the Draft-origin Send count guard is active, every optimistic Draft
  // count mutation (create/delete/send) must keep the guard synchronized with
  // the CURRENT logical Draft total. This is lifecycle-owned, not timer-owned.
  useEffect(() => {
    syncDraftCountGuardTotal(draftCountGuardRef.current, counts.drafts.total);
  }, [counts.drafts.total]);

  // Decide whether this (folder, sort, session) call can use the Local Mail Index.
  // Only "date-desc" is index-native; other sorts fall back to the bridge.
  const canUseIndex = useCallback(
    (f: MailFolder, s: SortOption) =>
      shouldUseLocalIndexForFolder({
        folder: f,
        sort: s,
        mailIndexEnabled: MAIL_INDEX_ENABLED,
        hasMailSessionToken: !!session?.mailSessionToken,
      }),
    [session],
  );

  const loadFromBridge = useCallback(
    async (reqId: number, requestScope: string) => {
      if (!session) return;
      const bridgeStartedAt = Date.now();
      try {
        const result = await getMessages({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder,
            limit: PAGE,
            offset: 0,
            sort,
          },
        });
        if (loadReqIdRef.current !== reqId || listScopeKeyRef.current !== requestScope) return;
        if (!result.ok) throw new Error(result.error);
        // BLOCKER_3: reconcile BEFORE applying overlay so the raw list
        // drives presence checks.
        reconcilePendingMovesForRead(result.messages, folder, bridgeStartedAt);
        const promoteKind = originKindForRestore(folder);
        if (promoteKind) {
          promotePendingOriginsForDestList(
            promoteKind,
            currentAccountId,
            promoteKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current,
            result.messages,
          );
        }

        loadedListScopeRef.current = requestScope;
        setMessages(applyPending(result.messages));
        setHasMore(result.messages.length >= PAGE);
        setBridgeError(null);
        setUseMock(false);
        setSource("bridge");
        setIndexCursor(null);
        setDraftListSettled(true);
      } catch (err: unknown) {
        if (loadReqIdRef.current !== reqId || listScopeKeyRef.current !== requestScope) return;
        setBridgeError(errorMessage(err, tr("تعذّر الاتصال بخادم البريد")));
        setHasMore(false);
        setUseMock(false);
        setIndexCursor(null);
        // UI-priority attempt settled (with an error) — allow background sync
        // to recover the index rather than leaving Draft sync disabled.
        setDraftListSettled(true);
      }
    },
    [session, folder, sort, getMessages, applyPending, reconcilePendingMovesForRead],
  );

  const loadMessages = useCallback(async () => {
    if (!session) return;
    const requestScope = listScopeKey;
    const reqId = ++loadReqIdRef.current;
    const isCurrentRequest = () =>
      loadReqIdRef.current === reqId && listScopeKeyRef.current === requestScope;
    // Timestamp captured BEFORE the request is issued. After the load
    // succeeds we drop every "confirmed" hide whose confirmedAt <= this
    // value: any mutation that confirmed before this load started is
    // guaranteed to be reflected in the response.
    const startedAt = Date.now();
    setLoading(true);
    try {
      // Sender Folder view — single indexed read over the Inbox index rows.
      if (senderView) {
        try {
          const res = await listSender({
            data: {
              mailSessionToken: session.mailSessionToken!,
              email: senderView,
              limit: PAGE,
            },
          });
          if (!isCurrentRequest()) return;
          if (res.ok) {
            loadedListScopeRef.current = requestScope;
            setMessages(applyPending(res.messages));
            // Local Index can hold only a synced Inbox slice. Keep historical
            // pagination available, but do no Bridge work until explicit
            // loadMore after the Local Index cursor is exhausted.
            setHasMore(true);
            setSenderCursor(res.nextCursor);
            senderHistoryRef.current = {
              scopeKey: `${session.account.id}|${senderView.trim().toLowerCase()}`,
              cursor: null,
              exhausted: false,
            };

            setIndexCursor(null);
            setSource("index");
            setUseMock(false);
            setBridgeError(null);
            gcHiddenBefore(pendingHiddenRef.current, startedAt);
            return;
          }
          setMessages([]);
          setHasMore(false);
          setSenderCursor(null);
          return;
        } catch {
          if (!isCurrentRequest()) return;
          setMessages([]);
          setHasMore(false);
          setSenderCursor(null);
          return;
        }
      }
      if (canUseIndex(folder, sort)) {
        try {
          const res = await listIndex({
            data: {
              mailSessionToken: session.mailSessionToken!,
              canonical: folder,
              limit: PAGE,
            },
          });
          if (!isCurrentRequest()) return;
          if (res.ok && res.indexed) {
            loadedListScopeRef.current = requestScope;
            reconcilePendingMovesForRead(res.messages, folder, startedAt);
            const promoteKind = originKindForRestore(folder);
            if (promoteKind) {
              promotePendingOriginsForDestList(
                promoteKind,
                currentAccountId,
                promoteKind === "trash"
                  ? trashUidValidityRef.current
                  : archiveUidValidityRef.current,
                res.messages,
              );
            }

            setMessages(applyPending(res.messages));
            setHasMore(res.hasMore);
            setIndexCursor(res.nextCursor);
            setSource("index");
            setUseMock(false);
            setBridgeError(null);
            setIndexReady((prev) => (prev[folder] ? prev : { ...prev, [folder]: true }));
            setDraftListSettled(true);
            gcHiddenBefore(pendingHiddenRef.current, startedAt);
            return;
          }
          // Not indexed yet OR transient error → mark not-ready and fall back.
          setIndexReady((prev) => (prev[folder] === false ? prev : { ...prev, [folder]: false }));
        } catch {
          setIndexReady((prev) => (prev[folder] === false ? prev : { ...prev, [folder]: false }));
        }
      }
      await loadFromBridge(reqId, requestScope);
      if (isCurrentRequest()) {
        gcHiddenBefore(pendingHiddenRef.current, startedAt);
      }
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [
    session,
    folder,
    sort,
    canUseIndex,
    listIndex,
    loadFromBridge,
    applyPending,
    senderView,
    listSender,
    listScopeKey,
  ]);

  const loadMore = useCallback(async () => {
    const requestScope = listScopeKey;
    const requestGeneration = loadReqIdRef.current;
    const isCurrentPagination = () =>
      loadReqIdRef.current === requestGeneration && listScopeKeyRef.current === requestScope;
    const historicalScope =
      session && senderView && !senderCursor
        ? `${session.account.id}|${senderView.trim().toLowerCase()}`
        : null;
    if (
      !session ||
      loadedListScopeRef.current !== requestScope ||
      loading ||
      !hasMore ||
      (!historicalScope && loadingMore)
    )
      return;
    if (!historicalScope) setLoadingMoreScope(requestScope);
    try {
      if (senderView) {
        if (!senderCursor) {
          // Index exhausted: one bounded sender-only page, only after the user
          // explicitly requests more. This never runs when the folder opens.
          const scopeKey = historicalScope!;
          let history = senderHistoryRef.current;
          if (!history || history.scopeKey !== scopeKey) {
            history = { scopeKey, cursor: null, exhausted: false };
            senderHistoryRef.current = history;
          }
          if (history.exhausted) {
            setHasMore(false);
            return;
          }
          const flightKey = `${scopeKey}|${history.cursor?.uidValidity ?? "start"}|${history.cursor?.beforeUid ?? "start"}`;
          if (senderHistoryFlightRef.current === flightKey) return;
          senderHistoryFlightRef.current = flightKey;
          setSenderHistoryLoadingScope(scopeKey);
          try {
            const deep = await getSenderHistoryPage({
              data: {
                mailSessionToken: session.mailSessionToken!,
                password: session.password,
                sender: senderView,
                limit: PAGE,
                cursor: history.cursor ?? undefined,
              },
            });
            if (
              !deep.ok ||
              loadReqIdRef.current !== requestGeneration ||
              senderScopeKeyRef.current !== scopeKey
            )
              return;
            const extra = applyPending(deep.messages);
            setMessages((prev) => mergeSenderMessagePages(prev, extra));
            history.cursor = deep.nextCursor;
            history.exhausted = !deep.hasMore;
            setHasMore(deep.hasMore);
          } catch {
            if (
              loadReqIdRef.current === requestGeneration &&
              senderScopeKeyRef.current === scopeKey
            )
              setHasMore(true);
          } finally {
            if (senderHistoryFlightRef.current === flightKey) {
              senderHistoryFlightRef.current = null;
            }
            setSenderHistoryLoadingScope((current) => (current === scopeKey ? null : current));
          }
          return;
        }
        const res = await listSender({
          data: {
            mailSessionToken: session.mailSessionToken!,
            email: senderView,
            limit: PAGE,
            cursor: senderCursor,
          },
        });
        if (!isCurrentPagination()) return;
        if (res.ok) {
          const patched = applyPending(res.messages);
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const merged = [...prev];
            for (const m of patched) if (!seen.has(m.id)) merged.push(m);
            return merged;
          });
          setHasMore(true);
          setSenderCursor(res.nextCursor);
          return;
        }
        setHasMore(false);
        return;
      }

      if (source === "index" && indexCursor && canUseIndex(folder, sort)) {
        const res = await listIndex({
          data: {
            mailSessionToken: session.mailSessionToken!,
            canonical: folder,
            limit: PAGE,
            cursor: indexCursor,
          },
        });
        if (!isCurrentPagination()) return;
        if (res.ok && res.indexed) {
          const patched = applyPending(res.messages);
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const merged = [...prev];
            for (const m of patched) if (!seen.has(m.id)) merged.push(m);
            return merged;
          });
          setHasMore(res.hasMore);
          setIndexCursor(res.nextCursor);
          return;
        }
        // Index no longer usable — stop paginating gracefully.
        setHasMore(false);
        return;
      }
      // Bridge pagination (offset-based).
      const offset = messages.length;
      const result = await getMessages({
        data: {
          mailSessionToken: session.mailSessionToken ?? "",
          password: session.password,
          folder,
          limit: PAGE,
          offset,
          sort,
        },
      });
      if (!isCurrentPagination()) return;
      if (!result.ok) throw new Error(result.error);
      const patched = applyPending(result.messages);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const merged = [...prev];
        for (const m of patched) if (!seen.has(m.id)) merged.push(m);
        return merged;
      });
      setHasMore(result.messages.length >= PAGE);
    } catch {
      if (isCurrentPagination()) setHasMore(false);
    } finally {
      if (!historicalScope) {
        setLoadingMoreScope((current) => (current === requestScope ? null : current));
      }
    }
  }, [
    session,
    folder,
    sort,
    getMessages,
    listIndex,
    messages.length,
    loadingMore,
    loading,
    hasMore,
    source,
    indexCursor,
    canUseIndex,
    senderView,
    senderCursor,
    listSender,
    getSenderHistoryPage,
    applyPending,
    listScopeKey,
  ]);

  // Counts on mount: Local-Index first (one Supabase SELECT, ~ms) instead of
  // a blocking Bridge/IMAP STATUS sweep. `loadCountsFast` falls back to the
  // Bridge automatically when the index has nothing for this account yet.
  useEffect(() => {
    loadCountsFast();
  }, [loadCountsFast]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Drafts now sync through the normal Local Index machinery, so entering
  // Drafts must NOT trigger a mandatory full /api/folders STATUS sweep. The
  // normal folder-change message load supplies the list; the Draft count comes
  // from lifecycle deltas + index reconciliation.
  const previousFolderForDraftRefreshRef = useRef<MailFolder>(folder);
  useEffect(() => {
    previousFolderForDraftRefreshRef.current = folder;
  }, [folder]);

  // Reset to default sort whenever the folder changes (no persistence between refreshes).
  useEffect(() => {
    setSort("date-desc");
  }, [folder]);

  // Background Local Mail Index sync — initial when not ready, incremental
  // afterwards, plus a 5-minute reconcile once the folder is indexed.
  // Pauses when the tab is hidden and never overlaps itself.
  const isFolderIndexed = indexReady[folder] === true;
  // The sync may only authorize a canonical self-heal on an authoritative
  // (Bridge-resolved) path. `folderPaths` may contain index-derived
  // (potentially corrupted) paths, so it is NOT used here. The sync path is:
  //   authoritativeFolderPath  (trusted)
  //   ?? unique non-ambiguous index path  (untrusted)
  //   ?? null (sync disabled until authoritative resolution)
  // An untrusted index path can run ordinary incremental/reconcile rounds but
  // NEVER rewrites/repairs canonical (pathTrusted stays false).
  const authoritativeFolderPath = authoritativeFolderPaths[folder] ?? null;
  const { syncPath, pathTrusted } = resolveSyncPath(
    authoritativeFolderPath,
    indexFolderCounts,
    folder,
  );
  const { reconcileNow, incrementalNow, shouldReconcile } = useMailIndexSync({
    session,
    folderPath: syncPath,
    canonical: folder,
    pathTrusted,
    indexed: isFolderIndexed,
    // Drafts/Trash: run the first bounded reconcile promptly (after the
    // visible list settles) so stale Local Index rows converge without the
    // normal 5-minute delay. Inbox/Sent keep the standard cadence.
    promptReconcile: folder === "drafts" || folder === "trash",
    enabled:
      MAIL_INDEX_ENABLED &&
      !!session?.mailSessionToken &&
      sort === "date-desc" &&
      // "starred" is a virtual view over INBOX (see mail-index.functions.ts):
      // its canonical name collides with inbox on the (account_id, path)
      // uniqueness of mail_folders, so a starred sync round would just
      // overwrite the inbox folder row with duplicate work and never serve
      // starred correctly. Bridge listing owns starred; do not sync it here.
      folder !== "starred" &&
      // Drafts: background initial sync is gated on the visible list having
      // settled (index hit or Bridge fallback applied/failed) so it never
      // competes with the UI-priority first page. Non-Draft folders unaffected.
      (folder !== "drafts" || draftListSettled),
    onSynced: () => {
      // Background rounds only: refresh the current folder from the index
      // when the sync actually changed something (the hook already gates on
      // meaningful-change; suppressed rounds do NOT reach this callback).
      // Drafts now use the Bridge Draft list as their visible authority. A
      // background Draft reconcile must keep the Local Index converged for
      // later provider UID suppression, but it must NOT cause a redundant
      // Bridge Draft list reload.
      if (folder !== "drafts") {
        loadMessages();
        loadCountsFast();
      } else {
        loadCountsFast({ draftIndexSyncSettled: true });
      }
    },
  });

  // Exceptional authoritative path resolution — ONLY when the current folder's
  // sync would be enabled but it has neither an authoritative path nor a unique
  // Local Index path (first-ever bootstrap for that folder, or an ambiguous /
  // missing / corrupted canonical). This never fires on a healthy warm indexed
  // session and never runs a global /api/folders sweep on every mount. It is
  // one-shot per (account + folder) via the ref guard.
  const authoritativeResolutionAttemptedRef = useRef<string>("");
  const syncEnabled =
    MAIL_INDEX_ENABLED &&
    !!session?.mailSessionToken &&
    sort === "date-desc" &&
    folder !== "starred" &&
    (folder !== "drafts" || draftListSettled);
  useEffect(() => {
    if (!syncEnabled) return;
    if (syncPath != null) return;
    // Only attempt authoritative resolution once we KNOW the Local Index is
    // healthy and non-empty but this folder has no usable row (missing or
    // ambiguous canonical). An empty index means loadCountsFast already fell
    // back to the authoritative bridge sweep — do not double-sweep here.
    if (indexFolderCounts.length === 0) return;
    const key = `${session?.account.id ?? ""}|${folder}`;
    if (authoritativeResolutionAttemptedRef.current === key) return;
    authoritativeResolutionAttemptedRef.current = key;
    void loadCounts();
  }, [syncEnabled, syncPath, indexFolderCounts.length, folder, session?.account.id, loadCounts]);

  const postSendRuntimeRef = useRef({
    session,
    folderPaths,
    syncFolder,
    loadCountsFast,
    loadMessages,
    currentAccountId,
  });
  postSendRuntimeRef.current = {
    session,
    folderPaths,
    syncFolder,
    loadCountsFast,
    loadMessages,
    currentAccountId,
  };
  const sentSyncCoalescerRef = useRef<ReturnType<typeof createSentSyncCoalescer> | null>(null);
  useEffect(() => {
    const coalescer = createSentSyncCoalescer(
      async (signal) => {
        const runtime = postSendRuntimeRef.current;
        const activeSession = runtime.session;
        if (!activeSession?.mailSessionToken) return "failed";
        const scopeAccountId = runtime.currentAccountId;
        try {
          const outcome = await runTargetedSentSync({
            signal,
            sentPath: runtime.folderPaths.sent,
            sync: (mode, folderPath) =>
              runtime.syncFolder({
                data: {
                  mailSessionToken: activeSession.mailSessionToken!,
                  password: activeSession.password,
                  folderPath,
                  canonical: "sent",
                  mode,
                },
              }),
            refreshCounts: async () => {
              if (postSendRuntimeRef.current.currentAccountId === scopeAccountId) {
                await postSendRuntimeRef.current.loadCountsFast();
              }
            },
            currentFolder: () => currentFolderRef.current,
            refreshSentList: async () => {
              if (postSendRuntimeRef.current.currentAccountId === scopeAccountId) {
                await postSendRuntimeRef.current.loadMessages();
              }
            },
          });
          if (outcome === "missing-path" || outcome === "failed") {
            toast.warning(tr("تم إرسال الرسالة، لكن تعذّر تحديث مجلد المرسلة."));
          }
          return outcome;
        } catch {
          if (postSendRuntimeRef.current.currentAccountId === scopeAccountId) {
            toast.warning(tr("تم إرسال الرسالة، لكن تعذّر تحديث مجلد المرسلة."));
          }
          return "failed";
        }
      },
      {
        onPersistentBusy: () => {
          toast.warning(tr("تم إرسال الرسالة، لكن تعذّر تحديث مجلد المرسلة."));
        },
      },
    );
    sentSyncCoalescerRef.current = coalescer;
    return () => {
      coalescer.dispose();
      if (sentSyncCoalescerRef.current === coalescer) sentSyncCoalescerRef.current = null;
    };
  }, [currentAccountId]);

  const postSendAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    postSendAbortRef.current?.abort();
    postSendAbortRef.current = controller;
    return () => controller.abort();
  }, [currentAccountId]);

  const onAfterSend = useCallback((info: PostSendInfo) => {
    const coalescerAtSend = sentSyncCoalescerRef.current;
    const requestSentSync = () => coalescerAtSend?.request() ?? Promise.resolve();
    const jobId = info.sentCopyJobId;
    const activeSession = postSendRuntimeRef.current.session;
    const controller = postSendAbortRef.current;
    void coordinateSentCopyCompletion({
      state: info.sentCopySaved ? "saved" : info.sentCopyState,
      pending: info.sentCopyPending,
      hasJob: Boolean(jobId && activeSession?.mailSessionToken && controller),
      watch: () =>
        watchSentCopy({
          signal: controller!.signal,
          check: async () => {
            const response = await fetch("/api/mail-sent-copy-status", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mailSessionToken: activeSession!.mailSessionToken,
                jobId,
              }),
              signal: controller!.signal,
            });
            return (await response.json().catch(() => ({ ok: false }))) as {
              ok: boolean;
              state?: SentCopyState;
              code?: string;
            };
          },
        }),
      requestSync: requestSentSync,
      warnCopyFailure: () => {
        toast.warning(tr("تم إرسال الرسالة، لكن تعذّر حفظ نسخة في مجلد المرسلة."));
      },
    });
  }, []);

  return {
    folder,
    setFolder,
    senderView,
    setSenderView,
    senderFolders,
    upsertSenderFolder,
    removeSenderFolder,
    folderPaths,

    sort,
    setSort,
    counts,
    setCounts,
    draftCountGuardRef,
    messages,
    setMessages,
    loading,
    loadingMore: isMailListLoadingMore(loadingMore, senderScopeKey, senderHistoryLoadingScope),
    listPaginationReady: loadedListScopeRef.current === listScopeKey,
    hasMore,
    loadMore,
    bridgeError,
    useMock,
    loadCounts,
    source,
    /**
     * Manual Refresh contract (locked by tests):
     *   incrementalNow=1, list=1, counts=1 (via loadCountsFast → Local Index),
     *   reconcileNow is NEVER awaited on the manual path. When it's due,
     *   scheduleBackground fires it after the spinner has already ended.
     */
    refresh: () =>
      runManualRefresh({
        incrementalNow,
        reconcileNow,
        shouldReconcile,
        loadMessages,
        loadCounts: loadCountsFast,
      }),
    // Non-destructive Draft recovery: the just-saved readability guard triggers
    // one incremental (no /api/folders) before a single message-open retry.
    incrementalNow,
    onAfterSend,
    onDraftCreated: () => {
      bumpCountsGen();
      setCounts((prev) => ({
        ...prev,
        drafts: { ...prev.drafts, total: prev.drafts.total + 1 },
      }));
    },
    refreshAfterComposerClose: async () => {
      // Draft V4: a successful save/delete already wrote the projection and
      // count (Local Index write-through + lifecycle delta), so NO global
      // /api/folders count sweep is needed. Refresh only the current list from
      // the Local Index when viewing Drafts.
      if (folder === "drafts") await loadMessages();
    },
    // Pending Flag Overrides — exposed so MailApp toggleStar/toggleRead can
    // record the expected value BEFORE the mutation resolves. All server-
    // list writers inside useMailData already patch through applyPending.
    pendingOverridesRef,
    setPendingFlagOverride: (id: string, patch: { starred?: boolean; read?: boolean }) => {
      // Batch A / Fix #1: any user-visible mutation invalidates in-flight
      // counts loaders — bump the monotonic generation so a stale response
      // returning after this call cannot overwrite optimistic counters.
      bumpCountsGen();
      setFlagOverride(pendingOverridesRef.current, id, patch);
    },
    clearPendingFlagOverride: (id: string, field?: "starred" | "read") => {
      if (field) clearFlagOverrideField(pendingOverridesRef.current, id, field);
      else clearFlagOverride(pendingOverridesRef.current, id);
    },
    hideRow: (id: string) => hideId(pendingHiddenRef.current, id),
    unhideRow: (id: string) => unhideId(pendingHiddenRef.current, id),
    confirmHideRow: (id: string, at: number = Date.now()) =>
      confirmHide(pendingHiddenRef.current, id, at),
    // BLOCKER_3: pending-move overlay lifecycle. Wrappers parse the
    // MailMessage id and forward to the pure overlay module. Persisted to
    // sessionStorage after every mutation so a refresh can't lose them.
    beginPendingMove: (id: string, operation: PendingMoveOperation) => {
      if (!currentAccountId) return;
      const parsed = parseMessageId(id);
      if (!parsed) return;
      // Batch A / Fix #1: bump BEFORE the mutation network call starts so
      // any counts request already in-flight is invalidated.
      bumpCountsGen();
      beginPendingMoveEntry(pendingMovesRef.current, {
        accountId: currentAccountId,
        sourceFolder: parsed.folder,
        sourceUid: parsed.uid,
        messageId: id,
        operation,
      });
      persistPendingMoves();
    },
    confirmPendingMove: (id: string) => {
      if (!currentAccountId) return;
      const parsed = parseMessageId(id);
      if (!parsed) return;
      // Confirmation writes new optimistic counters; invalidate racers.
      bumpCountsGen();
      confirmPendingMoveEntry(pendingMovesRef.current, {
        accountId: currentAccountId,
        sourceFolder: parsed.folder,
        sourceUid: parsed.uid,
      });
      persistPendingMoves();
    },
    rollbackPendingMove: (id: string) => {
      if (!currentAccountId) return;
      const parsed = parseMessageId(id);
      if (!parsed) return;
      // Rollback restores previous counters; invalidate racers too.
      bumpCountsGen();
      rollbackPendingMoveEntry(pendingMovesRef.current, {
        accountId: currentAccountId,
        sourceFolder: parsed.folder,
        sourceUid: parsed.uid,
      });
      persistPendingMoves();
    },
    clearAllPendingMoves: () => {
      if (!currentAccountId) return;
      const removed = clearPendingMovesForAccount(pendingMovesRef.current, currentAccountId);
      if (removed > 0) persistPendingMoves();
    },
    // V4: star-mutation lifecycle hooks used by toggleStar to hold the
    // Starred count against racing loaders.
    beginStarMutation: () => {
      bumpCountsGen();
      pendingStarMutRef.current.active++;
    },
    endStarMutation: () => {
      const s = pendingStarMutRef.current;
      if (s.active > 0) s.active--;
      s.settledAt = Date.now();
    },

    applyPending,
    applyPendingOne,
    // Batch A: expose the pending-move overlay ref and the monotonic count
    // generation bumper so MailApp (fetchMessage / mutation handlers) can
    // consult and advance them without duplicating state.
    pendingMovesRef,
    trashUidValidityRef,
    archiveUidValidityRef,
    bumpCountsGen,
  };
}

function MailApp() {
  const navigate = useNavigate();
  const { dir: uiDir } = useLanguage();
  const { confirm } = useConfirm();
  const [session, setSession] = useState<MailSession | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeInitial | null>(null);
  const [draftEditComposeNonce, setDraftEditComposeNonce] = useState(0);
  const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);
  const [reading, setReading] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectMode, setSelectMode] = useState(false);

  const openDraftEdit = useCallback((initial: ComposeInitial) => {
    if (isDraftEditComposeInitial(initial)) {
      setDraftEditComposeNonce((current) => current + 1);
    }
    setCompose(initial);
  }, []);

  // Guarded navigation: if the composer is open with unsaved changes, prompt
  // (Save / Discard / Cancel) before running the destructive nav action.
  async function guardComposerNav(): Promise<boolean> {
    if (typeof window === "undefined") return true;
    const g = (
      window as unknown as { __mailmaestroComposerGuard?: (() => Promise<boolean>) | null }
    ).__mailmaestroComposerGuard;
    if (!g) return true;
    return g();
  }
  const [refreshing, setRefreshing] = useState(false);
  const [searchMode, setSearchMode] = useState<"quick" | "deep">("quick");
  // Mobile-only: expand the search field in place and hide the trailing icons.
  const [searchFocused, setSearchFocused] = useState(false);
  // Keep the search bar expanded while the search-type dropdown is open,
  // because its content is portaled outside the search container.
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const [deepIncludeBody, setDeepIncludeBody] = useState(false);
  const [deepResults, setDeepResults] = useState<MailMessage[] | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);

  const {
    folder,
    setFolder,
    senderView,
    setSenderView,
    senderFolders,
    upsertSenderFolder,
    removeSenderFolder,
    folderPaths,
    sort,

    setSort,
    counts,
    setCounts,
    draftCountGuardRef,
    messages,
    setMessages,
    loading,
    loadingMore,
    listPaginationReady,
    hasMore,
    loadMore,
    bridgeError,
    useMock,
    loadCounts,
    refresh: rawRefresh,
    incrementalNow,
    onAfterSend,
    onDraftCreated,
    refreshAfterComposerClose,
    setPendingFlagOverride,
    clearPendingFlagOverride,
    hideRow,
    unhideRow,
    confirmHideRow,
    beginPendingMove,
    confirmPendingMove,
    rollbackPendingMove,
    clearAllPendingMoves,
    beginStarMutation,
    endStarMutation,

    applyPending,
    applyPendingOne,
    pendingMovesRef,
    trashUidValidityRef,
    archiveUidValidityRef,
    bumpCountsGen,
  } = useMailData(session || null);

  // Draft-folder-only server projection. This is intentionally outside the
  // shared list loader so Inbox/Sent/startup make no Working Draft request.
  const [workingDraftRecords, setWorkingDraftRecords] = useState<WorkingDraftRecord[]>([]);
  const [sentDraftRefs, setSentDraftRefs] = useState<WorkingDraftSentRef[]>([]);
  const [sendingProviderRefs, setSendingProviderRefs] = useState<WorkingDraftSentRef[]>([]);
  const [discardedProviderRefs, setDiscardedProviderRefs] = useState<WorkingDraftSentRef[]>([]);
  const [workingDraftsLoaded, setWorkingDraftsLoaded] = useState(false);
  const [workingDraftsSettled, setWorkingDraftsSettled] = useState(false);
  const workingDraftProjectionScopeRef = useRef<string>("");
  const draftReconciledMessagesRef = useRef<MailMessage[]>([]);
  const draftReconciledScopeRef = useRef<string>("");
  const workingDraftsRequestRef = useRef(0);
  const refreshWorkingDrafts = useCallback(async () => {
    const requestId = ++workingDraftsRequestRef.current;
    if (folder !== "drafts" || !session?.mailSessionToken) {
      setWorkingDraftRecords([]);
      setSentDraftRefs([]);
      setSendingProviderRefs([]);
      setDiscardedProviderRefs([]);
      setWorkingDraftsLoaded(false);
      setWorkingDraftsSettled(false);
      return;
    }
    setWorkingDraftsLoaded(false);
    setWorkingDraftsSettled(false);
    try {
      const response = await fetch("/api/mail-working-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailSessionToken: session.mailSessionToken, action: "list" }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        records?: WorkingDraftRecord[];
        sentDraftRefs?: WorkingDraftSentRef[];
        sendingProviderRefs?: WorkingDraftSentRef[];
        discardedProviderRefs?: WorkingDraftSentRef[];
      } | null;
      if (response.ok && result?.ok && Array.isArray(result.records)) {
        if (requestId !== workingDraftsRequestRef.current) return;
        workingDraftProjectionScopeRef.current = session?.account.id ?? "";
        setWorkingDraftRecords(result.records);
        const sentRefs = Array.isArray(result.sentDraftRefs) ? result.sentDraftRefs : [];
        setSentDraftRefs(sentRefs);
        setSendingProviderRefs(
          Array.isArray(result.sendingProviderRefs) ? result.sendingProviderRefs : [],
        );
        setDiscardedProviderRefs(
          Array.isArray(result.discardedProviderRefs) ? result.discardedProviderRefs : [],
        );
        setWorkingDraftsLoaded(true);
        const guard = draftCountGuardRef.current;
        reconcileDraftCountGuardCleanup(guard, result.records, sentRefs);
      }
    } catch {
      // Provider Drafts remain usable while this optional projection retries
      // on the next Draft-folder visit.
    } finally {
      if (requestId === workingDraftsRequestRef.current) {
        setWorkingDraftsSettled(true);
      }
    }
  }, [folder, session?.account.id, session?.mailSessionToken, draftCountGuardRef]);

  const rememberWorkingDraftRecord = useCallback((record: WorkingDraftRecord) => {
    setWorkingDraftRecords((current) => {
      const existingIndex = current.findIndex((item) => item.draftId === record.draftId);
      if (existingIndex === -1) return [...current, record];
      const next = [...current];
      next[existingIndex] = record;
      return next;
    });
  }, []);

  const currentMailSessionTokenRef = useRef<string>(session?.mailSessionToken ?? "");
  currentMailSessionTokenRef.current = session?.mailSessionToken ?? "";

  /**
   * Exact logical Draft lookup. A provider Draft row with a valid
   * X-MailMaestro-Draft-ID must resolve through this BEFORE generic
   * /api/message so a list-load race can never open a stale physical UID.
   */
  const loadWorkingDraftById = useCallback(
    async (draftId: string): Promise<WorkingDraftRecord | null> => {
      const token = currentMailSessionTokenRef.current;
      if (!token || !draftId) return null;
      try {
        const response = await fetch("/api/mail-working-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mailSessionToken: token, action: "load", draftId }),
        });
        const result = (await response.json().catch(() => null)) as {
          ok?: boolean;
          record?: WorkingDraftRecord | null;
        } | null;
        const record = result?.ok ? result.record : null;
        if (!record || !Number.isSafeInteger(record.revision)) return null;
        rememberWorkingDraftRecord(record);
        return record;
      } catch {
        return null;
      }
    },
    [rememberWorkingDraftRecord],
  );

  const resolveDraftWorkingRecord = useCallback(
    async (
      row: MailMessage | null,
      parsed: ReturnType<typeof parseMessageId>,
    ): Promise<WorkingDraftRecord | null> => {
      if (!row) return null;
      const isServerWorkingRow = row.id.startsWith("working-draft:");
      if (parsed && parsed.folder !== "drafts" && !isServerWorkingRow) return null;
      const target = chooseDraftOpenTarget({
        rowId: row.id,
        draftIdHeader: row.draftIdHeader,
        uidValidity: parsed ? (validUidValidity(row.uidValidity) ?? undefined) : undefined,
        uid: parsed?.uid ?? 0,
        records: workingDraftRecords,
        isDraftIdValid: (value) => UUID_RE.test(value),
      });
      if (target.kind === "server-working") return target.record;
      if (target.kind === "working-by-header") return loadWorkingDraftById(target.draftId);
      return null;
    },
    [workingDraftRecords, loadWorkingDraftById],
  );

  useEffect(() => {
    void refreshWorkingDrafts();
  }, [refreshWorkingDrafts]);

  // Sender Folders — O(1) lookup for the per-row folder icon.
  const senderFolderMap = useMemo(
    () => new Map(senderFolders.map((f) => [f.email.toLowerCase(), f])),
    [senderFolders],
  );
  const [senderDialog, setSenderDialog] = useState<{
    email: string;
    name: string;
    color: string;
    existing: boolean;
  } | null>(null);
  const [senderDialogBusy, setSenderDialogBusy] = useState(false);
  const openSenderFolderDialog = useCallback(
    (m: MailMessage) => {
      const email = (m.from.email || "").toLowerCase();
      if (!email) return;
      const found = senderFolderMap.get(email);
      setSenderDialog({
        email,
        name: found?.name ?? (m.from.name || email),
        color: found?.color ?? "blue",
        existing: !!found,
      });
    },
    [senderFolderMap],
  );

  // BLOCKER_6 — account identity for origin-tracker calls in this scope.
  const currentAccountId = session?.account.id ?? null;

  // Just-saved Draft readability guard (in-memory, per browser session).
  // A first NOT_FOUND for a Draft we just saved is NOT proof of a ghost.
  const savedDraftGuardRef = useRef<SavedDraftGuard | null>(null);
  if (!savedDraftGuardRef.current) savedDraftGuardRef.current = createSavedDraftGuard();

  // Clear a stale just-saved Draft marker when the account/session changes.
  const lastDraftGuardAccountRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastDraftGuardAccountRef.current;
    lastDraftGuardAccountRef.current = currentAccountId;
    if (prev && prev !== currentAccountId) savedDraftGuardRef.current?.clearAll();
  }, [currentAccountId]);

  // Plumbed from the Composer: a confirmed remote save records the draft's
  // exact remote identity; delete/discard/send clears it.
  const handleDraftSaved = useCallback(
    (
      identity: SavedDraftIdentity,
      previousRef?: { folderPath: string; uid: number; uidValidity: string } | null,
    ) => {
      if (!currentAccountId) {
        savedDraftGuardRef.current?.record(identity);
        return;
      }
      if (
        previousRef &&
        previousRef.uid !== identity.uid &&
        previousRef.folderPath === identity.folderPath
      ) {
        savedDraftGuardRef.current?.recordReplacement(
          {
            accountId: currentAccountId,
            draftId: identity.draftId,
            folderPath: previousRef.folderPath,
            uidValidity: previousRef.uidValidity,
            uid: previousRef.uid,
          },
          identity,
        );
        return;
      }
      savedDraftGuardRef.current?.record(identity);
    },
    [currentAccountId],
  );
  const draftDeleteSnapshotRef = useRef<{
    messages: MailMessage[];
    workingDraftRecords: WorkingDraftRecord[];
    draftsTotal: number;
  } | null>(null);

  const handleDraftDeleted = useCallback(
    (draftId: string) => {
      draftDeleteSnapshotRef.current = null;
      if (currentAccountId) savedDraftGuardRef.current?.clearDraft(currentAccountId, draftId);
    },
    [currentAccountId],
  );

  // Optimistic Draft-only delete: remove the row(s) and decrement the count
  // once, BEFORE the explicit server delete settles. The snapshot is restored
  // if the delete fails so the row/count never lie.
  const handleDraftDeleteStart = useCallback(
    (draftId: string, options?: { activateDraftCountGuard?: boolean }) => {
      const snapshot = {
        messages,
        workingDraftRecords,
        draftsTotal: counts.drafts.total,
      };
      draftDeleteSnapshotRef.current = snapshot;
      const next = applyDraftDeleteOptimistic(snapshot, draftId);
      bumpCountsGen();
      if (options?.activateDraftCountGuard) {
        activateDraftCountGuard(draftCountGuardRef.current, next.draftsTotal, draftId);
      }
      setMessages(next.messages);
      setWorkingDraftRecords(next.workingDraftRecords);
      setCounts((prev) => ({
        ...prev,
        drafts: {
          ...prev.drafts,
          total: next.draftsTotal,
        },
      }));
    },
    [bumpCountsGen, counts.drafts.total, messages, workingDraftRecords],
  );

  const handleDraftDeleteRollback = useCallback(
    (draftId: string) => {
      const snapshot = draftDeleteSnapshotRef.current;
      draftDeleteSnapshotRef.current = null;
      if (!snapshot) return;
      void draftId;
      const restored = rollbackDraftDeleteOptimistic(snapshot);
      bumpCountsGen();
      setMessages(restored.messages);
      setWorkingDraftRecords(restored.workingDraftRecords);
      setCounts((prev) => ({
        ...prev,
        drafts: { ...prev.drafts, total: restored.draftsTotal },
      }));
    },
    [bumpCountsGen],
  );

  // Serialize Refresh with a single-flight guard (ref, not React state) so a
  // double-click that fires before the next render can't spawn a second
  // incrementalNow. `refreshing` state stays as the visual spinner only.
  const refreshFlightRef = useRef(createSingleFlight<void>());
  const refresh = useCallback((): Promise<void> => {
    if (refreshFlightRef.current.isBusy()) {
      return refreshFlightRef.current.run(() => Promise.resolve());
    }
    setRefreshing(true);
    return refreshFlightRef.current.run(async () => {
      try {
        await rawRefresh();
      } finally {
        setRefreshing(false);
      }
    });
  }, [rawRefresh]);

  // Cache-first open: Postgres body cache → (miss) bridge interactive lane.
  const openMsg = useMailServerFn(openMailMessage);
  const prefetchWindowFn = useMailServerFn(prefetchMessageWindow);
  const resolveInlineImagesBackground = useMailServerFn(resolveMessageInlineImages);
  const cleanupGhost = useMailServerFn(tombstoneGhostMessage);

  // Mirror of `messages` so the open path can merge a cached body into the
  // clicked row without re-creating the callback on every list change.
  const messagesRef = useRef<MailMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const markRead = useMailServerFn(bridgeMarkRead);
  const star = useMailServerFn(bridgeStar);
  const updateFlag = useMailServerFn(indexUpdateFlag);
  const move = useMailServerFn(bridgeMove);
  const deleteFn = useMailServerFn(bridgeDelete);
  const moveIndex = useMailServerFn(indexMoveMessage);
  const deleteIndex = useMailServerFn(indexDeleteMessage);
  const searchFn = useMailServerFn(bridgeSearch);

  // Preferred path for \Seen / \Flagged mutations:
  //   session has mailSessionToken → indexUpdateFlag (IMAP + Local Index
  //   write-through in one round). Falls back to raw bridge for legacy
  //   sessions with no token. Throws on any failure so callers' optimistic
  //   rollback in .catch fires.
  const mutateFlag = useCallback(
    async (canonical: MailFolder, uid: number, kind: "seen" | "flagged", value: boolean) => {
      if (!session) throw new Error(tr("لا توجد جلسة بريد"));
      if (session.mailSessionToken) {
        const res = await updateFlag({
          data: {
            mailSessionToken: session.mailSessionToken,
            password: session.password,
            canonical,
            uid,
            kind,
            value,
          },
        });
        if (!res.ok) throw new Error(res.error);
        return;
      }
      if (kind === "seen") {
        await markRead({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder: canonical,
            uid,
            read: value,
          },
        });
      } else {
        await star({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder: canonical,
            uid,
            starred: value,
          },
        });
      }
    },
    [session, updateFlag, markRead, star],
  );

  // Move/Trash orchestration
  // ------------------------
  // Preferred path when a mail-session JWT is present: `indexMoveMessage`
  // performs Bridge move + Local Index write-through in one round and
  // throws on any failure (including bridge non-ok). Legacy sessions with
  // no token fall back to the raw bridge endpoints (`move` / `deleteFn`).
  const mutateMoveOrDelete = useCallback(
    async (params: {
      sourceCanonical: MailFolder;
      uid: number;
      /** Omit → permanent delete (only valid when sourceCanonical === "trash"). */
      toFolder?: MailFolder;
    }): Promise<IndexMoveResult | null> => {
      if (!session) throw new Error(tr("لا توجد جلسة بريد"));
      const dest = params.toFolder;
      // Permanent-delete branch — MUST use indexDeleteMessage (Blocker 1).
      if (dest === undefined) {
        if (params.sourceCanonical !== "trash") {
          throw new Error(tr("الحذف النهائي مسموح فقط من مجلد المهملات"));
        }
        if (session.mailSessionToken) {
          const res = await deleteIndex({
            data: {
              mailSessionToken: session.mailSessionToken,
              password: session.password,
              canonical: "trash",
              uid: params.uid,
            },
          });
          if (!res.ok) throw new Error(res.error);
          return null;
        }
        await deleteFn({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder: params.sourceCanonical,
            uid: params.uid,
          },
        });
        return null;
      }
      // Move branch — IMAP MOVE + local write-through in one round.
      if (session.mailSessionToken) {
        const res = await moveIndex({
          data: {
            mailSessionToken: session.mailSessionToken,
            password: session.password,
            sourceCanonical: params.sourceCanonical,
            destCanonical: dest,
            uid: params.uid,
          },
        });
        if (!res.ok) throw new Error(res.error);
        // BLOCKER_C — return the orchestration result so the caller can
        // extract Trash identity (UIDPLUS + discovered UID) for the origin
        // tracker. IMAP is the source of truth; discovery may be absent
        // when the destination sync was busy/failed, and the caller falls
        // back to a pending origin in that case.
        return res;
      }
      await move({
        data: {
          mailSessionToken: session.mailSessionToken ?? "",
          password: session.password,
          folder: params.sourceCanonical,
          uid: params.uid,
          toFolder: dest,
        },
      });
      return null;
    },
    [session, moveIndex, deleteIndex, deleteFn, move],
  );

  // Per-id single-flight guard against double-click on Move/Delete/Restore.
  // Same id in flight → returns the same promise instead of firing IMAP twice.
  const moveFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const runMoveFlight = useCallback(
    async (id: string, worker: () => Promise<void>): Promise<void> => {
      const existing = moveFlightRef.current.get(id);
      if (existing) return existing;
      const p = worker().finally(() => {
        moveFlightRef.current.delete(id);
      });
      moveFlightRef.current.set(id, p);
      return p;
    },
    [],
  );

  type ClientMessageSource =
    | "memory"
    | "server-cache"
    | "imap"
    | "error"
    | "draft-syncing"
    | "draft-working-record"
    | "draft-provider-gone";
  type ClientMessageResult = {
    message: MailMessage | null;
    source: ClientMessageSource;
    draftRecord?: WorkingDraftRecord | null;
  };
  type MessageOpenContext =
    | { kind: "current-list"; intent?: MessageOpenIntent }
    | { kind: "historical"; base: MailMessage };
  type MessageCacheFacade = {
    get: (id: string) => MailMessage | undefined;
    set: (id: string, message: MailMessage) => void;
    delete: (id: string) => void;
    clear: () => void;
  };

  const messageMemoryRef = useRef<MessageMemoryCache | null>(null);
  if (!messageMemoryRef.current) messageMemoryRef.current = new MessageMemoryCache();
  const cacheScopeRef = useRef<MessageCacheScope | null>(null);
  cacheScopeRef.current = session
    ? {
        companyId: session.company?.id ?? session.account.company_id,
        accountId: session.account.id,
      }
    : null;
  const messageCache = useRef<MessageCacheFacade>({
    get: (id) => {
      const scope = cacheScopeRef.current;
      const parsed = parseMessageId(id);
      if (!scope || !parsed) return undefined;
      const base = messagesRef.current.find((message) => message.id === id);
      if (!base || !validUidValidity(base.uidValidity)) return undefined;
      return messageMemoryRef.current?.get(scope, base) ?? undefined;
    },
    set: (_id, message) => {
      const scope = cacheScopeRef.current;
      if (!scope) return;
      messageMemoryRef.current?.set(scope, message);
      const stats = messageMemoryRef.current?.stats();
      if (stats) mailPerf("message-memory-cache", { ...stats });
    },
    delete: (id) => {
      const scope = cacheScopeRef.current;
      if (scope) messageMemoryRef.current?.delete(scope, id);
    },
    clear: () => messageMemoryRef.current?.clear(),
  });
  type InflightMessage = {
    promise: Promise<ClientMessageResult>;
    controller: AbortController;
    lane: "interactive" | "background";
  };
  const inflight = useRef<Map<string, InflightMessage>>(new Map());
  const activeScopeGenerationRef = useRef(0);

  // Non-destructive recovery for a just-saved Draft whose first interactive
  // open returned NOT_FOUND (the provider may not yet expose the freshly
  // APPENDed UID to the interactive connection). Runs at most ONE incremental
  // (no /api/folders) + ONE message-open retry per exact identity; never
  // tombstones, never hides the row, never decrements the Draft count.
  const recoverJustSavedDraft = useCallback(
    async (
      identity: SavedDraftIdentity,
      uid: number,
      uidValidity: string,
      scope: { companyId: string; accountId: string },
      base: MailMessage | null,
      preserveAlias = false,
    ): Promise<ClientMessageResult> => {
      const guard = savedDraftGuardRef.current;
      if (!guard || !session) return { message: null, source: "error" };

      if (!guard.hasRecoveryAttempted(identity)) {
        guard.markRecoveryAttempted(identity);
        // ONE non-destructive Draft incremental. If it is busy/fails, the
        // retry still runs; never a repeated loop.
        try {
          await incrementalNow({ suppressOnSynced: true });
        } catch {
          /* retry the open regardless */
        }
        // ONE message-open retry for the SAME uid.
        try {
          const retry = await openMsg({
            data: {
              mailSessionToken: session.mailSessionToken ?? "",
              password: session.password,
              folder: "drafts",
              uid,
              lane: "interactive",
              allowCache: base != null,
            },
          });
          let recovered: MailMessage | null = null;
          let recoveredSource: ClientMessageSource = "imap";
          if (retry.ok && retry.source === "imap" && retry.message) {
            recovered = retry.message;
          } else if (retry.ok && retry.source === "cache" && base) {
            recovered = {
              ...base,
              body: retry.body.bodyHtml,
              preview: retry.body.preview || base.preview,
              inlineParts: retry.body.inlineParts,
              inlineImages: retry.body.inlineImages,
              attachments: retry.body.attachments,
              mailedBy: retry.body.mailedBy ?? base.mailedBy,
              signedBy: retry.body.signedBy ?? base.signedBy,
              security: retry.body.security ?? base.security,
              replyTo: retry.body.replyTo ?? base.replyTo,
              hasAttachments: retry.body.attachments.length > 0,
              uidValidity: base.uidValidity ?? retry.body.uidValidity,
            };
            recoveredSource = "server-cache";
          }
          if (recovered) {
            const patched = applyPendingOne(recovered);
            messageMemoryRef.current?.set(scope, patched);
            if (!preserveAlias) guard.clearDraft(identity.accountId, identity.draftId);
            return { message: patched, source: recoveredSource };
          }
        } catch {
          /* fall through to the transient syncing state */
        }
      }

      // Still not openable (or recovery already attempted): leave the row
      // visible and surface a non-destructive transient state — never a ghost.
      return { message: null, source: "draft-syncing" };
    },
    [session, openMsg, incrementalNow, applyPendingOne],
  );

  // Draft-only stale-revision redirect. It performs ONE current-UID fetch and
  // never touches Inbox/Sent or the normal successful open path.
  const openDraftByIdentity = useCallback(
    async (identity: SavedDraftIdentity, signal?: AbortSignal): Promise<ClientMessageResult> => {
      if (!session) return { message: null, source: "error" };
      const scope = {
        companyId: session.company?.id ?? session.account.company_id,
        accountId: session.account.id,
      };
      if (currentAccountId) {
        savedDraftGuardRef.current?.markInFlight(
          identity.accountId,
          identity.uidValidity,
          identity.uid,
        );
      }
      try {
        const opened = await openMsg({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder: "drafts",
            uid: identity.uid,
            lane: "interactive",
            allowCache: false,
          },
          signal,
        });
        if (opened.ok && opened.source === "imap" && opened.message) {
          const patched = applyPendingOne(opened.message);
          messageMemoryRef.current?.set(scope, patched);
          return { message: patched, source: "imap" };
        }
        if (!opened.ok && opened.code === "NOT_FOUND") {
          return recoverJustSavedDraft(
            identity,
            identity.uid,
            identity.uidValidity,
            scope,
            null,
            true,
          );
        }
        return { message: null, source: "error" };
      } catch {
        return { message: null, source: "error" };
      } finally {
        if (currentAccountId) {
          savedDraftGuardRef.current?.releaseInFlight(
            identity.accountId,
            identity.uidValidity,
            identity.uid,
          );
        }
      }
    },
    [session, openMsg, applyPendingOne, recoverJustSavedDraft],
  );

  const fetchMessage = useCallback(
    async (
      id: string,
      lane: "interactive" | "background" = "interactive",
      signal?: AbortSignal,
      context: MessageOpenContext = { kind: "current-list" },
    ): Promise<ClientMessageResult> => {
      if (!session) return Promise.resolve({ message: null, source: "error" });
      // Batch A / Fix #2: check the pending-move overlay BEFORE reading
      // cache. A source row the user just moved must not be resurrected
      // from a warm cache entry that was stored before the mutation.
      // Destination rows resolve to a different physical folder — they are
      // NOT suppressed by design (see isMessageSuppressed).
      const accountId = currentAccountId;
      if (accountId && isMessageSuppressed(pendingMovesRef.current, accountId, id)) {
        return Promise.resolve({ message: null, source: "error" });
      }
      const scope = {
        companyId: session.company?.id ?? session.account.company_id,
        accountId: session.account.id,
      };
      const suppliedBase = context.kind === "historical" ? context.base : null;
      const parsed = parseMessageId(id);
      if (!parsed) return Promise.resolve({ message: null, source: "error" });
      // Envelope row from the list: a cache HIT only ships the body, so the
      // headers/flags are merged from the row the user clicked. Without a
      // base row we force a full live fetch (allowCache: false).
      const suppliedIdentity = suppliedBase ? parseMessageId(suppliedBase.id) : null;
      if (
        suppliedBase &&
        (!suppliedIdentity ||
          suppliedIdentity.folder !== parsed.folder ||
          suppliedIdentity.uid !== parsed.uid)
      ) {
        return Promise.resolve({ message: null, source: "error" });
      }
      const base = suppliedBase ?? messagesRef.current.find((m) => m.id === id) ?? null;
      const uidValidity = validUidValidity(base?.uidValidity);
      if (lane === "background" && !uidValidity) {
        return Promise.resolve({ message: null, source: "error" });
      }
      // PART B: Draft stale-revision fence. If this exact Draft UID was already
      // replaced by a newer UID in this browser session, never FETCH the old
      // UID. Interactive opens redirect to the current UID; background/prefetch
      // work is discarded silently.
      const staleDraftIdentity =
        parsed.folder === "drafts" && currentAccountId && uidValidity
          ? (savedDraftGuardRef.current?.findStale(currentAccountId, uidValidity, parsed.uid) ??
            null)
          : null;
      const preNetworkDecision = decidePreNetworkDraftOpen({
        isDraft: parsed.folder === "drafts",
        lane,
        contextKind: context.kind,
        staleIdentity: staleDraftIdentity,
      });
      if (preNetworkDecision.type === "discard") {
        return Promise.resolve({ message: null, source: "error" });
      }
      if (preNetworkDecision.type === "redirect") {
        return openDraftByIdentity(preNetworkDecision.identity, signal);
      }
      const cached = suppliedBase
        ? (messageMemoryRef.current?.get(scope, suppliedBase) ?? undefined)
        : messageCache.current.get(id);
      if (cached) return Promise.resolve({ message: cached, source: "memory" });
      const fetchUid = parsed.uid;
      const fetchBase = base;
      const intent = context.kind === "current-list" ? context.intent : undefined;
      const intentKey = intent ? `|intent:${intent.scope}:${intent.generation}` : "";
      const requestKey = `${scope.companyId}|${scope.accountId}|${parsed.folder}|${fetchUid}|${uidValidity ?? "interactive"}${intentKey}`;
      const existing = inflight.current.get(requestKey);
      if (existing) {
        if (existing.lane === "background" && lane === "interactive") {
          // A speculative background prefetch must never gate a user click.
          // The click proceeds with its own interactive request immediately;
          // the background request keeps running and fills the same memory
          // cache, so its network work is not discarded.
          inflight.current.delete(requestKey);
        } else {
          return existing.promise;
        }
      }
      if (parsed.folder === "drafts" && currentAccountId && uidValidity) {
        savedDraftGuardRef.current?.markInFlight(currentAccountId, uidValidity, fetchUid);
      }
      const scopeGeneration = activeScopeGenerationRef.current;
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abortFromCaller, { once: true });
      const p = openMsg({
        data: {
          mailSessionToken: session.mailSessionToken ?? "",
          password: session.password,
          folder: parsed.folder,
          uid: fetchUid,
          lane,
          allowCache: fetchBase != null,
          ...(context.kind === "current-list" && context.intent
            ? {
                openIntentScope: context.intent.scope,
                openIntentGeneration: context.intent.generation,
              }
            : {}),
        },
        signal: controller.signal,
      })
        .then(async (result) => {
          if (scopeGeneration !== activeScopeGenerationRef.current || controller.signal.aborted) {
            mailPerf("stale-response-dropped", { phase: "scope" });
            return { message: null, source: "error" } as ClientMessageResult;
          }
          // PART C: a Draft fetch that started before save completion may now be
          // obsolete. Its result/error must not be applied, cached, cleaned up,
          // or surfaced. Interactive opens retry the current UID exactly once;
          // background/prefetch work is discarded silently.
          const staleAtSettlement =
            parsed.folder === "drafts" && currentAccountId && uidValidity
              ? (savedDraftGuardRef.current?.findStale(currentAccountId, uidValidity, fetchUid) ??
                null)
              : null;
          const settlementDecision = decideSettledDraftFetch({
            isDraft: parsed.folder === "drafts",
            fetchedUid: fetchUid,
            lane,
            contextKind: context.kind,
            staleIdentity: staleAtSettlement,
          });
          if (settlementDecision.type === "discard") {
            return { message: null, source: "error" } as ClientMessageResult;
          }
          if (settlementDecision.type === "redirect") {
            return openDraftByIdentity(settlementDecision.identity, signal);
          }
          if (context.kind === "historical") {
            const returnedUidValidity = validUidValidity(
              result.ok && result.source === "cache"
                ? result.body.uidValidity
                : result.ok && result.source === "imap"
                  ? result.message?.uidValidity
                  : null,
            );
            if (!uidValidity || returnedUidValidity !== uidValidity) {
              return { message: null, source: "error" } as ClientMessageResult;
            }
          }
          const merged: MailMessage | null =
            result.ok && result.source === "cache" && fetchBase
              ? {
                  ...fetchBase,
                  body: result.body.bodyHtml,
                  preview: result.body.preview || fetchBase.preview,
                  inlineParts: result.body.inlineParts,
                  inlineImages: result.body.inlineImages,
                  attachments: result.body.attachments,
                  mailedBy: result.body.mailedBy ?? fetchBase.mailedBy,
                  signedBy: result.body.signedBy ?? fetchBase.signedBy,
                  security: result.body.security ?? fetchBase.security,
                  replyTo: result.body.replyTo ?? fetchBase.replyTo,
                  hasAttachments: result.body.attachments.length > 0,
                  uidValidity: fetchBase.uidValidity ?? result.body.uidValidity,
                }
              : result.ok && result.source === "imap"
                ? context.kind === "historical" && result.message
                  ? {
                      ...fetchBase,
                      ...result.message,
                      id: fetchBase!.id,
                      folder: fetchBase!.folder,
                      uidValidity: result.message.uidValidity ?? fetchBase!.uidValidity,
                    }
                  : result.message
                : null;
          if (merged) {
            // Batch A / Fix #2: re-check the overlay AFTER the fetch. The
            // user may have moved this row during the round-trip; writing
            // it into messageCache would let it re-appear.
            const acc = currentAccountId;
            if (acc && isMessageSuppressed(pendingMovesRef.current, acc, id)) {
              return { message: null, source: "error" } as ClientMessageResult;
            }
            // Patch through pending overrides so a slow fetch response cannot
            // overwrite an in-flight optimistic star/read the user just set.
            const patched = applyPendingOne(merged);
            messageMemoryRef.current?.set(scope, patched);
            // A successful open of a just-saved Draft clears its readability
            // marker (section 6A) so a later real ghost for the SAME identity
            // can never be suppressed.
            if (parsed.folder === "drafts" && currentAccountId && uidValidity) {
              const matched = savedDraftGuardRef.current?.find(
                currentAccountId,
                uidValidity,
                fetchUid,
              );
              if (matched)
                savedDraftGuardRef.current?.clearDraft(matched.accountId, matched.draftId);
            }
            return {
              message: patched,
              source: result.ok && result.source === "cache" ? "server-cache" : "imap",
            } as ClientMessageResult;
          }
          // A speculative/background fetch must never mutate the mailbox
          // index. NOT_FOUND may be transient while a folder sync is racing.
          // Cleanup is allowed only after an explicit interactive open.
          if (!result.ok && result.code === "NOT_FOUND") {
            if (lane === "background" || context.kind === "historical") {
              return { message: null, source: "error" } as ClientMessageResult;
            }

            // Just-saved Draft readability guard: a first NOT_FOUND for a
            // Draft we successfully saved THIS session is NOT proof of a ghost
            // (the provider may not yet expose the fresh APPEND UID to the
            // interactive connection). Intercept only the exact identity.
            const protectedDraft =
              parsed.folder === "drafts" && currentAccountId && uidValidity
                ? (savedDraftGuardRef.current?.find(currentAccountId, uidValidity, fetchUid) ??
                  null)
                : null;
            if (protectedDraft && uidValidity) {
              return recoverJustSavedDraft(protectedDraft, fetchUid, uidValidity, scope, fetchBase);
            }

            if (parsed.folder === "drafts") {
              // Physical Draft UID NOT_FOUND is transport state. It must never
              // destroy the logical MailMaestro Working Draft or run generic
              // destructive ghost cleanup.
              const logicalRecord = await resolveDraftWorkingRecord(fetchBase, parsed);
              if (logicalRecord) {
                return {
                  message: null,
                  source: "draft-working-record",
                  draftRecord: logicalRecord,
                } as ClientMessageResult;
              }

              // Provider-only/legacy physical Draft disappeared. Reconcile only
              // the physical row, never a logical Draft, and never decrement the
              // logical Draft count.
              messageCache.current.delete(id);
              setMessages((prev) => prev.filter((m) => m.id !== id));
              hideRow(id);
              setSelectedId((cur) => (cur === id ? null : cur));
              setSelectedMessage((cur) => (cur && cur.id === id ? null : cur));
              toast.info(tr("تعذّر فتح هذه المسودة. تم تحديث قائمة المسودات."));
              return { message: null, source: "draft-provider-gone" } as ClientMessageResult;
            }

            if (parsed.folder !== "all") {
              void cleanupGhost({
                data: {
                  mailSessionToken: session.mailSessionToken ?? "",
                  canonical: parsed.folder,
                  uid: fetchUid,
                  uidvalidity: uidValidity ? Number(uidValidity) : undefined,
                },
              }).catch(() => {});
            }
            messageCache.current.delete(id);
            setMessages((prev) => prev.filter((m) => m.id !== id));
            hideRow(id);
            setSelectedId((cur) => (cur === id ? null : cur));
            setSelectedMessage((cur) => (cur && cur.id === id ? null : cur));
            toast.info(tr("تم إزالة رسالة مفقودة من القائمة"));
            return { message: null, source: "error" } as ClientMessageResult;
          }

          return { message: null, source: "error" } as ClientMessageResult;
        })
        .catch(() => ({ message: null, source: "error" }) as ClientMessageResult)
        .finally(() => {
          signal?.removeEventListener("abort", abortFromCaller);
          if (parsed.folder === "drafts" && currentAccountId && uidValidity) {
            savedDraftGuardRef.current?.releaseInFlight(currentAccountId, uidValidity, fetchUid);
          }
          if (inflight.current.get(requestKey)?.promise === p) inflight.current.delete(requestKey);
        });
      inflight.current.set(requestKey, { promise: p, controller, lane });
      return p;
    },
    [
      session,
      openMsg,
      applyPendingOne,
      currentAccountId,
      cleanupGhost,
      recoverJustSavedDraft,
      openDraftByIdentity,
      resolveDraftWorkingRecord,
    ],
  );

  const openHistoricalMessage = useCallback(
    (row: ConversationRow): HistoricalOpenAttempt => {
      if (!session) return { kind: "error" };
      const base = conversationRowBase(row);
      if (!validUidValidity(base.uidValidity)) return { kind: "error" };
      if (
        currentAccountId &&
        isMessageSuppressed(pendingMovesRef.current, currentAccountId, base.id)
      ) {
        return { kind: "error" };
      }
      const scope = {
        companyId: session.company?.id ?? session.account.company_id,
        accountId: session.account.id,
      };
      const cached = messageMemoryRef.current?.get(scope, base) ?? null;
      if (cached) return { kind: "memory", message: cached };
      return {
        kind: "pending",
        promise: fetchMessage(base.id, "interactive", undefined, {
          kind: "historical",
          base,
        }).then((result) => result.message),
      };
    },
    [currentAccountId, fetchMessage, pendingMovesRef, session],
  );

  const prefetchQueueRef = useRef<AdaptivePrefetchQueue<ClientMessageResult> | null>(null);
  if (!prefetchQueueRef.current) {
    prefetchQueueRef.current = new AdaptivePrefetchQueue<ClientMessageResult>();
  }
  const prefetchCidWantedRef = useRef<Set<string>>(new Set());
  const prefetchWindowFlightRef = useRef<{
    key: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const hoverPrefetchTimersRef = useRef<Map<string, number>>(new Map());
  const cancelIdlePrefetchRef = useRef<(() => void) | null>(null);
  const uidValidityByScopeRef = useRef<Map<string, string>>(new Map());
  const navigationGenerationRef = useRef<NavigationGeneration | null>(null);
  if (!navigationGenerationRef.current)
    navigationGenerationRef.current = new NavigationGeneration();
  const messageOpenIntentRef = useRef<MessageOpenIntentGeneration | null>(null);
  if (!messageOpenIntentRef.current)
    messageOpenIntentRef.current = new MessageOpenIntentGeneration();

  const prefetchCidForMessage = useCallback(
    async (message: MailMessage, signal?: AbortSignal): Promise<void> => {
      if (!session || !message.inlineParts?.length) return;
      const present = new Set((message.inlineImages ?? []).map((image) => image.cid.toLowerCase()));
      const parts = partitionInlineCidParts(message.inlineParts, present).smallBatchParts;
      if (parts.length === 0) return;
      const parsed = parseMessageId(message.id);
      const uidValidity = validUidValidity(message.uidValidity);
      if (!parsed || !uidValidity || signal?.aborted) return;
      const scopeGeneration = activeScopeGenerationRef.current;
      const scope = {
        companyId: session.company?.id ?? session.account.company_id,
        accountId: session.account.id,
      };
      const key = `${scope.companyId}|${scope.accountId}|${parsed.folder}|${parsed.uid}|${uidValidity}`;
      let entry = inlineImageFlights.get(key);
      if (!entry) {
        mailPerf("cid-request-start", { count: parts.length, background: true });
        const controller = new AbortController();
        const abortFromQueue = () => controller.abort();
        signal?.addEventListener("abort", abortFromQueue, { once: true });
        const promise = resolveInlineImagesBackground({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder: parsed.folder,
            uid: parsed.uid,
            uidValidity,
            parts,
            persist: false,
          },
          signal: controller.signal,
        }).finally(() => {
          signal?.removeEventListener("abort", abortFromQueue);
          if (inlineImageFlights.get(key)?.promise === promise) inlineImageFlights.delete(key);
        });
        entry = { promise, controller };
        inlineImageFlights.set(key, entry);
      }
      const result = await entry.promise;
      if (!result.ok || signal?.aborted || scopeGeneration !== activeScopeGenerationRef.current)
        return;
      const decoded = await decodeInlineMappings(
        result.images.map((image) => ({ cid: image.cid, dataUri: image.dataUri })),
      );
      if (decoded.length === 0 || scopeGeneration !== activeScopeGenerationRef.current) return;
      const decodedCids = new Set(decoded.map((image) => image.cid.toLowerCase()));
      const successful = result.images.filter((image) => decodedCids.has(image.cid.toLowerCase()));
      const current = messageMemoryRef.current?.get(scope, message) ?? message;
      const byCid = new Map(
        (current.inlineImages ?? []).map((image) => [image.cid.toLowerCase(), image]),
      );
      for (const image of successful) byCid.set(image.cid.toLowerCase(), image);
      const updated = { ...current, inlineImages: [...byCid.values()] };
      messageMemoryRef.current?.set(scope, updated);
      setSelectedMessage((selected) =>
        selected?.id === updated.id
          ? { ...selected, inlineImages: updated.inlineImages }
          : selected,
      );
      mailPerf("cid-decoded", { count: successful.length, background: true });
    },
    [session, resolveInlineImagesBackground],
  );

  const prefetchMessage = useCallback(
    (
      id: string,
      priority: PrefetchPriority,
      withCid = false,
      lane: "interactive" | "background" = "background",
    ) => {
      if (!session) return Promise.resolve(undefined);
      const identity = parseMessageId(id);
      if (!identity || identity.folder !== folder) return Promise.resolve(undefined);
      const scopeKey = `${session.company?.id ?? session.account.company_id}|${session.account.id}|${folder}|${id}`;
      if (withCid) prefetchCidWantedRef.current.add(scopeKey);
      const cached = messageCache.current.get(id);
      if (cached) {
        mailPerf("prefetch-hit", { source: "memory" });
        if (!withCid) {
          return Promise.resolve({ message: cached, source: "memory" } as ClientMessageResult);
        }
      }
      const base = messagesRef.current.find((message) => message.id === id);
      if (!base || !validUidValidity(base.uidValidity)) return Promise.resolve(undefined);
      return prefetchQueueRef.current!.enqueue(scopeKey, priority, async (signal) => {
        if (signal.aborted) return { message: null, source: "error" };
        mailPerf("prefetch-start", { priority });
        const result = await fetchMessage(id, lane, signal);
        if (result.message && prefetchCidWantedRef.current.has(scopeKey)) {
          await prefetchCidForMessage(result.message, signal);
        }
        prefetchCidWantedRef.current.delete(scopeKey);
        mailPerf(result.message ? "prefetch-hit" : "prefetch-miss", { source: result.source });
        return result;
      });
    },
    [session, folder, fetchMessage, prefetchCidForMessage],
  );

  const prefetchWindow = useCallback(
    (ids: string[]) => {
      if (!session || ids.length === 0) return Promise.resolve();
      const scopeGeneration = activeScopeGenerationRef.current;
      const candidates = ids.flatMap((id) => {
        if (messageCache.current.get(id)) return [];
        const parsed = parseMessageId(id);
        const base = messagesRef.current.find((message) => message.id === id);
        const uidValidity = validUidValidity(base?.uidValidity);
        return parsed?.folder === folder && uidValidity
          ? [{ id, uid: parsed.uid, uidValidity, base: base! }]
          : [];
      });
      if (!candidates.length) return Promise.resolve();
      const scopeKey = `${session.company?.id ?? session.account.company_id}|${session.account.id}|${folder}`;
      const key = `${scopeKey}|${candidates.map((candidate) => `${candidate.uid}:${candidate.uidValidity}`).join(",")}`;
      const existing = prefetchWindowFlightRef.current;
      if (existing?.key === key) return existing.promise;
      existing?.controller.abort();
      const controller = new AbortController();
      mailPerf("prefetch-start", { priority: "visible", count: candidates.length, batch: true });
      const promise = prefetchWindowFn({
        data: {
          mailSessionToken: session.mailSessionToken ?? "",
          password: session.password,
          folder,
          messages: candidates.map(({ uid, uidValidity }) => ({ uid, uidValidity })),
        },
        signal: controller.signal,
      })
        .then((result) => {
          if (
            !result.ok ||
            controller.signal.aborted ||
            scopeGeneration !== activeScopeGenerationRef.current
          )
            return;
          const byUid = new Map(candidates.map((candidate) => [candidate.uid, candidate]));
          const scope = {
            companyId: session.company?.id ?? session.account.company_id,
            accountId: session.account.id,
          };
          for (const item of result.messages) {
            const candidate = byUid.get(item.uid);
            if (!candidate) continue;
            const merged =
              item.source === "cache" && item.body
                ? {
                    ...candidate.base,
                    body: item.body.bodyHtml,
                    preview: item.body.preview || candidate.base.preview,
                    inlineParts: item.body.inlineParts,
                    inlineImages: item.body.inlineImages,
                    attachments: item.body.attachments,
                    mailedBy: item.body.mailedBy ?? candidate.base.mailedBy,
                    signedBy: item.body.signedBy ?? candidate.base.signedBy,
                    security: item.body.security ?? candidate.base.security,
                    replyTo: item.body.replyTo ?? candidate.base.replyTo,
                    hasAttachments: item.body.attachments.length > 0,
                  }
                : item.message
                  ? { ...candidate.base, ...item.message, id: candidate.id, folder }
                  : null;
            if (merged && !controller.signal.aborted) {
              messageMemoryRef.current?.set(scope, applyPendingOne(merged));
            }
          }
          mailPerf("prefetch-hit", { source: "batch", count: result.messages.length });
        })
        .catch(() => undefined)
        .finally(() => {
          if (prefetchWindowFlightRef.current?.promise === promise) {
            prefetchWindowFlightRef.current = null;
          }
        });
      prefetchWindowFlightRef.current = { key, controller, promise };
      return promise;
    },
    [applyPendingOne, folder, prefetchWindowFn, session],
  );

  useCompanyTheme(
    session?.company
      ? { primary: session.company.brand_primary, accent: session.company.brand_accent }
      : { primary: "#0F172A", accent: "#3B82F6" },
  );

  useEffect(() => {
    const s = getMailSession();
    if (!s) {
      navigate({ to: "/login" });
      return;
    }
    setSession(s);
  }, [navigate]);

  const resetAsyncScope = useCallback((clearMemory: boolean) => {
    cancelScheduledPrefetch(
      hoverPrefetchTimersRef.current,
      cancelIdlePrefetchRef.current,
      window.clearTimeout.bind(window),
    );
    cancelIdlePrefetchRef.current = null;
    abortInflightControllers(inflight.current);
    abortInlineImageFlights();
    if (clearMemory) clearLargeInlineCidSessionCache();
    prefetchWindowFlightRef.current?.controller.abort();
    prefetchWindowFlightRef.current = null;
    prefetchQueueRef.current?.cancelAll();
    prefetchCidWantedRef.current.clear();
    navigationGenerationRef.current?.invalidate();
    activeScopeGenerationRef.current += 1;
    if (clearMemory) {
      messageOpenIntentRef.current?.resetScope();
      messageCache.current.clear();
      uidValidityByScopeRef.current.clear();
    }
  }, []);

  // Silent Mail Session renewal: keeps the short-lived token fresh in the
  // background so an expired session never surfaces as a "connection" error.
  // Only when renewal itself fails (wrong/changed password) do we sign out.
  useMailSessionRenewal({
    onExpired: () => {
      resetAsyncScope(true);
      clearMailSession();
      toast.error(tr("انتهت جلسة البريد. يرجى تسجيل الدخول مجدداً."));
      navigate({ to: "/login" });
    },
  });

  const previousScopeRef = useRef({
    companyId: session?.company?.id ?? session?.account.company_id ?? "",
    accountId: session?.account.id ?? "",
    folder,
  });

  // Folder switches cancel speculative work but retain completed LRU entries.
  // Company/account switches are hard privacy boundaries and wipe memory.
  useEffect(() => {
    const next = {
      companyId: session?.company?.id ?? session?.account.company_id ?? "",
      accountId: session?.account.id ?? "",
      folder,
    };
    const previous = previousScopeRef.current;
    const identityChanged =
      previous.companyId !== next.companyId || previous.accountId !== next.accountId;
    resetAsyncScope(identityChanged);
    previousScopeRef.current = next;
    if (identityChanged) {
      messagesRef.current = [];
      setMessages([]);
      setSelectedId(null);
      setSelectedMessage(null);
      setReading(false);
    }
    setSelection(new Set());
    setSelectMode(false);
  }, [
    folder,
    resetAsyncScope,
    session?.account.company_id,
    session?.account.id,
    session?.company?.id,
    setMessages,
  ]);

  // Clear deep search results when leaving deep mode or switching folder.
  useEffect(() => {
    setDeepResults(null);
    setDeepError(null);
  }, [folder, searchMode]);

  // Debounced server-side search — only fires in "deep" mode with 2+ chars.
  // Uses IMAP SEARCH on the origin server (headers by default, optional BODY).
  useEffect(() => {
    if (searchMode !== "deep" || !session) return;
    const q = query.trim();
    if (q.length < 2) {
      setDeepResults(null);
      setDeepError(null);
      setDeepLoading(false);
      return;
    }
    let cancelled = false;
    setDeepLoading(true);
    setDeepError(null);
    const t = setTimeout(async () => {
      try {
        const res = await searchFn({
          data: {
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            folder,
            query: q,
            includeBody: deepIncludeBody,
            limit: 100,
          },
        });
        if (cancelled) return;
        if (res.ok) setDeepResults(applyPending(res.messages));
        else {
          setDeepResults([]);
          setDeepError(res.error || tr("فشل البحث على السيرفر"));
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setDeepResults([]);
          setDeepError(errorMessage(err, tr("فشل البحث على السيرفر")));
        }
      } finally {
        if (!cancelled) setDeepLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searchMode, deepIncludeBody, folder, session, searchFn]);

  const visibleMessages = useMemo(() => {
    if (folder !== "drafts") return messages;
    const projectionMatchesCurrent = workingDraftProjectionScopeRef.current === currentAccountId;
    const scopedWorkingDraftRecords = projectionMatchesCurrent ? workingDraftRecords : [];
    const scopedSentDraftRefs = projectionMatchesCurrent ? sentDraftRefs : [];
    const scopedSendingProviderRefs = projectionMatchesCurrent ? sendingProviderRefs : [];
    const scopedDiscardedProviderRefs = projectionMatchesCurrent ? discardedProviderRefs : [];
    const enrichedProviderMessages = messages.map((message) => {
      const parsed = parseMessageId(message.id);
      if (!parsed || message.draftIdHeader) return message;
      const uidValidity = validUidValidity(message.uidValidity);
      const draftId = uidValidity
        ? findWorkingDraftIdByServerRef(scopedWorkingDraftRecords, uidValidity, parsed.uid)
        : null;
      return draftId ? { ...message, draftIdHeader: draftId } : message;
    });

    const providerSuppressionRefs = [
      ...scopedSentDraftRefs,
      ...scopedSendingProviderRefs,
      ...scopedDiscardedProviderRefs,
    ];
    const visibleProviderMessages = enrichedProviderMessages.filter((message) => {
      const parsed = parseMessageId(message.id);
      if (!parsed) return true;
      const uidValidity = validUidValidity(message.uidValidity);
      if (isSentProviderDraftRef(uidValidity ?? undefined, parsed.uid, providerSuppressionRefs)) {
        return false;
      }
      return !isStaleProviderDraftRow({
        draftIdHeader: message.draftIdHeader,
        messageUid: parsed.uid,
        messageUidValidity: uidValidity ?? undefined,
        workingDraftRecords: scopedWorkingDraftRecords,
      });
    });
    const providerDraftIds = new Set(
      visibleProviderMessages
        .map((message) => message.draftIdHeader)
        .filter((value): value is string => Boolean(value)),
    );
    const ownAddress = session?.account.email_address ?? "";
    const serverOnly = scopedWorkingDraftRecords
      .filter((record) => !providerDraftIds.has(record.draftId))
      .map<MailMessage>((record) => {
        const snapshot = record.payload.snapshot;
        const normalAttachments = record.payload.attachments.filter(
          (item) => item.kind === "attachment",
        );
        return {
          id: `working-draft:${record.draftId}`,
          threadId: `working-draft:${record.draftId}`,
          folder: "drafts",
          from: { name: session?.account.display_name ?? ownAddress, email: ownAddress },
          to: (snapshot.to ?? [])
            .filter((item) => item.valid !== false)
            .map((item) => ({ name: item.name ?? "", email: item.email })),
          cc: (snapshot.cc ?? [])
            .filter((item) => item.valid !== false)
            .map((item) => ({ name: item.name ?? "", email: item.email })),
          subject: snapshot.subject || tr("(بدون موضوع)"),
          preview: stripHtml(snapshot.html).slice(0, 240),
          body: snapshot.html,
          date: record.updatedAt,
          read: true,
          starred: false,
          hasAttachments: record.payload.attachments.length > 0,
          attachments: normalAttachments.map((item) => ({
            id: item.clientKey,
            filename: item.filename,
            size: item.size,
            mimeType: item.mimeType,
            disposition: item.disposition,
          })),
          draftIdHeader: record.draftId,
        };
      });
    const reconciled = [...serverOnly, ...visibleProviderMessages].sort(
      (a, b) => Date.parse(b.date) - Date.parse(a.date),
    );
    if (!workingDraftsSettled) {
      return draftReconciledScopeRef.current === currentAccountId
        ? draftReconciledMessagesRef.current
        : [];
    }
    if (!workingDraftsLoaded) {
      return draftReconciledScopeRef.current === currentAccountId
        ? draftReconciledMessagesRef.current
        : reconciled;
    }
    draftReconciledMessagesRef.current = reconciled;
    draftReconciledScopeRef.current = currentAccountId ?? "";
    return reconciled;
  }, [
    folder,
    messages,
    session,
    workingDraftRecords,
    sentDraftRefs,
    sendingProviderRefs,
    discardedProviderRefs,
    workingDraftsSettled,
    workingDraftsLoaded,
    currentAccountId,
  ]);

  const filteredMessages = useMemo(() => {
    // Deep server-side search: always show server results (even empty).
    if (searchMode === "deep" && query.trim().length >= 2) {
      return deepResults ?? [];
    }
    if (!query.trim()) return visibleMessages;
    const q = query.toLowerCase();
    return visibleMessages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.name.toLowerCase().includes(q) ||
        m.from.email.toLowerCase().includes(q) ||
        m.preview.toLowerCase().includes(q),
    );
  }, [visibleMessages, query, searchMode, deepResults]);
  const inDeepSearch = searchMode === "deep" && query.trim().length >= 2;
  const effectiveLoading = folder === "drafts" ? loading || !workingDraftsSettled : loading;
  useEffect(() => {
    messagesRef.current = filteredMessages;
    const scope = cacheScopeRef.current;
    const authoritative = filteredMessages.find((message) =>
      Boolean(validUidValidity(message.uidValidity)),
    );
    const parsed = authoritative ? parseMessageId(authoritative.id) : null;
    const uidValidity = validUidValidity(authoritative?.uidValidity);
    if (scope && parsed && parsed.folder === folder && uidValidity) {
      const scopeKey = `${scope.companyId}|${scope.accountId}|${parsed.folder}`;
      const previous = uidValidityByScopeRef.current.get(scopeKey);
      if (previous && previous !== uidValidity) {
        resetAsyncScope(false);
        setSelectedId(null);
        setSelectedMessage(null);
        setReading(false);
      }
      uidValidityByScopeRef.current.set(scopeKey, uidValidity);
      messageMemoryRef.current?.retainUidValidity(scope, parsed.folder, uidValidity);
    }
  }, [filteredMessages, folder, resetAsyncScope]);

  // Lifecycle-based stale Draft alias pruning. Run only after the visible
  // Draft list has settled, using the authoritative UIDs currently exposed.
  useEffect(() => {
    if (folder !== "drafts" || loading || !currentAccountId) return;
    const authoritative = filteredMessages.find((message) =>
      Boolean(validUidValidity(message.uidValidity)),
    );
    const uidValidity = validUidValidity(authoritative?.uidValidity);
    if (!uidValidity) return;
    const uids = new Set<number>();
    for (const message of filteredMessages) {
      if (message.folder !== "drafts") continue;
      const parsed = parseMessageId(message.id);
      if (parsed && parsed.uid > 0) uids.add(parsed.uid);
    }
    savedDraftGuardRef.current?.pruneAfterAuthoritativeRefresh(currentAccountId, uidValidity, uids);
  }, [folder, loading, filteredMessages, currentAccountId]);

  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  const widePrefetch = shouldUseWidePrefetch(connection);

  useEffect(() => {
    if (!session || loading || folder === "drafts" || !widePrefetch) return;
    const ids = firstVisiblePrefetchIds(
      filteredMessages.map((message) => message.id),
      10,
    );
    if (ids.length === 0) return;
    let cancelled = false;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const run = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      void prefetchWindow(ids);
    };
    const handle = idleWindow.requestIdleCallback
      ? idleWindow.requestIdleCallback(run, { timeout: 1_500 })
      : window.setTimeout(run, 350);
    const cancel = () => {
      cancelled = true;
      if (idleWindow.cancelIdleCallback) {
        idleWindow.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
    cancelIdlePrefetchRef.current = cancel;
    return () => {
      cancel();
      if (cancelIdlePrefetchRef.current === cancel) cancelIdlePrefetchRef.current = null;
    };
  }, [filteredMessages, folder, loading, prefetchWindow, session, widePrefetch]);

  useEffect(() => {
    if (!selectedId || !session || !widePrefetch) return;
    const ids = adjacentPrefetchIds(
      filteredMessages.map((message) => message.id),
      selectedId,
      5,
    );
    void prefetchWindow([selectedId, ...ids].slice(0, 10));
  }, [filteredMessages, prefetchWindow, selectedId, session, widePrefetch]);

  const cancelHoverPrefetch = useCallback(
    (id: string) => {
      const timer = hoverPrefetchTimersRef.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      hoverPrefetchTimersRef.current.delete(id);
      if (session) {
        const key = `${session.company?.id ?? session.account.company_id}|${session.account.id}|${folder}|${id}`;
        if (prefetchQueueRef.current?.cancel(key)) mailPerf("prefetch-aborted", { count: 1 });
        prefetchCidWantedRef.current.delete(key);
      }
    },
    [folder, session],
  );
  const scheduleHoverPrefetch = useCallback(
    (id: string) => {
      if (!widePrefetch || hoverPrefetchTimersRef.current.has(id)) return;
      const timer = window.setTimeout(() => {
        hoverPrefetchTimersRef.current.delete(id);
        void prefetchMessage(id, "hover");
      }, 120);
      hoverPrefetchTimersRef.current.set(id, timer);
    },
    [prefetchMessage, widePrefetch],
  );
  useEffect(
    () => () => {
      for (const timer of hoverPrefetchTimersRef.current.values()) window.clearTimeout(timer);
      hoverPrefetchTimersRef.current.clear();
    },
    [],
  );

  async function openMessage(id: string) {
    if (!(await guardComposerNav())) return;
    const parsed = parseMessageId(id);
    const base = filteredMessages.find((message) => message.id === id) ?? null;
    const draftRecord =
      parsed?.folder === "drafts" || id.startsWith("working-draft:")
        ? await resolveDraftWorkingRecord(base, parsed)
        : null;
    if (draftRecord) {
      // Draft-only fast path: logical Working Draft wins BEFORE any generic
      // provider /api/message request. This is independent of whether the
      // Working Draft list request has completed.
      openDraftEdit(buildWorkingDraftInitial(draftRecord));
      setSelectedId(null);
      setSelectedMessage(null);
      setReading(false);
      return;
    }
    const intent = messageOpenIntentRef.current!.next(id);
    // Drop speculative work queued for the previous intent. An already
    // running single-flight may still be reused by this foreground open.
    const aborted = prefetchQueueRef.current?.pendingKeys().length ?? 0;
    prefetchQueueRef.current?.cancelAll({ abortRunning: false });
    prefetchWindowFlightRef.current?.controller.abort();
    prefetchWindowFlightRef.current = null;
    if (aborted > 0) mailPerf("prefetch-aborted", { count: aborted });
    prefetchCidWantedRef.current.clear();
    const startedAt = performance.now();
    const generation = navigationGenerationRef.current!.next();
    setSelectedId(id);
    if (!parsed || !session) {
      setSelectedMessage(getMockMessage(id) ?? null);
      return;
    }
    const baseUidValidity = validUidValidity(base?.uidValidity);
    const staleDraftIdentity =
      parsed.folder === "drafts" && currentAccountId && baseUidValidity
        ? (savedDraftGuardRef.current?.findStale(currentAccountId, baseUidValidity, parsed.uid) ??
          null)
        : null;
    const preNetworkDecision = decidePreNetworkDraftOpen({
      isDraft: parsed.folder === "drafts",
      lane: "interactive",
      contextKind: "current-list",
      staleIdentity: staleDraftIdentity,
    });
    const cached = preNetworkDecision.type === "normal" ? messageCache.current.get(id) : undefined;
    mailPerf("message-click-to-shell", { elapsedMs: Math.round(performance.now() - startedAt) });
    if (cached) {
      setSelectedMessage(cached);
      setReading(false);
      mailPerf("message-click-to-body", {
        source: "memory",
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } else {
      setSelectedMessage(base);
      setReading(true);
    }
    try {
      const result = cached
        ? ({ message: cached, source: "memory" } as ClientMessageResult)
        : preNetworkDecision.type === "redirect"
          ? await openDraftByIdentity(preNetworkDecision.identity)
          : await fetchMessage(id, "interactive", undefined, { kind: "current-list", intent });
      if (!navigationGenerationRef.current!.isCurrent(generation)) {
        mailPerf("stale-response-dropped", { phase: "navigation" });
        return;
      }
      const msg = result.message;
      if (msg) {
        setSelectedMessage(msg);
        setReading(false);
        if (!cached) {
          mailPerf("message-click-to-body", {
            source: result.source,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }
      } else if (result.source === "draft-syncing") {
        // Non-destructive transient state: the just-saved Draft is not yet
        // openable. Keep the row visible and never surface a generic failure.
        setReading(false);
        toast.info(tr("المسودة لا تزال قيد المزامنة، حاول فتحها بعد لحظات."));
        return;
      } else if (result.source === "draft-working-record" && result.draftRecord) {
        // A Draft NOT_FOUND raced with the Working Draft list and the exact
        // logical record was recovered. Open it without a generic message call.
        openDraftEdit(buildWorkingDraftInitial(result.draftRecord));
        setSelectedId(null);
        setSelectedMessage(null);
        setReading(false);
        return;
      } else if (result.source === "draft-provider-gone") {
        // The physical provider-only row was already reconciled and notified.
        setReading(false);
        return;
      } else if (!cached) throw new Error(tr("فشل فتح الرسالة"));

      // M4-C: Drafts folder → open the message directly inside the composer
      // as an Edit-Draft (server-side draft is the source of truth). We
      // intentionally do this AFTER the fetch so the composer receives full
      // recipients / body / attachments metadata rather than list-preview.
      const loaded = msg ?? cached ?? null;
      if (loaded && parsed.folder === "drafts") {
        const draftsPath = folderPaths.drafts ?? undefined;
        openDraftEdit(buildEditDraft(loaded, draftsPath));
        setSelectedId(null);
        setSelectedMessage(null);
        setReading(false);
        return;
      }

      const listMsg = filteredMessages.find((m) => m.id === id);
      if (listMsg && !listMsg.read) {
        // Optimistic read
        setPendingFlagOverride(id, { read: true });
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: true } : m)));
        setCounts((prev) => {
          const cur = prev[parsed.folder];
          if (!cur || cur.unread <= 0) return prev;
          return { ...prev, [parsed.folder]: { ...cur, unread: cur.unread - 1 } };
        });
        const c = messageCache.current.get(id);
        if (c) messageCache.current.set(id, { ...c, read: true });
        mutateFlag(parsed.folder, parsed.uid, "seen", true).catch(() => {
          clearPendingFlagOverride(id, "read");
        });
      }
    } catch (err: unknown) {
      if (!cached && navigationGenerationRef.current!.isCurrent(generation)) {
        toast.error(errorMessage(err, tr("فشل فتح الرسالة")));
        setSelectedMessage(getMockMessage(id) ?? null);
      }
    } finally {
      if (navigationGenerationRef.current!.isCurrent(generation)) setReading(false);
    }
  }

  async function toggleStar(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    // Prev value from the ACTUALLY VISIBLE source: Deep Search overrides the
    // regular list, and messages the row may not exist in at all.
    const inDeep = searchMode === "deep" && query.trim().length >= 2;
    const source = inDeep && deepResults ? deepResults : messages;
    const msg = source.find((m) => m.id === id);
    const nextStarred = !msg?.starred;
    // Record expected value first so any in-flight list write (background
    // sync, refresh, pagination, deep search) cannot clobber it.
    setPendingFlagOverride(id, { starred: nextStarred });
    // V4: mark the star-count "hot" so any concurrent counts loader keeps
    // the optimistic value instead of the still-stale server total.
    beginStarMutation();
    // Optimistic counter — starred.total moves by exactly one and never
    // dips below zero. Rolled back below on failure via the inverse delta.
    setCounts((prev) => {
      const cur = prev.starred;
      if (!cur) return prev;
      const delta = nextStarred ? 1 : -1;
      return { ...prev, starred: { ...cur, total: Math.max(0, cur.total + delta) } };
    });
    // Snapshot for potential rollback (used when we optimistically REMOVE
    // the row from the "starred" folder view on unstar).
    let starredFolderSnapshot: { list: MailMessage[]; index: number } | null = null;
    if (folder === "starred" && !nextStarred) {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx >= 0) {
        starredFolderSnapshot = { list: messages, index: idx };
        hideRow(id);
        setMessages((prev) => prev.filter((m) => m.id !== id));
      }
    } else {
      // Re-starring anywhere: clear any hide for THIS id and, crucially,
      // clear the "starred:<uid>" namespaced hide too — the row might
      // have been unstarred from the Starred view earlier and its hide
      // entry is keyed by that folder-prefixed id. Without this, the
      // freshly-restarred row would still be filtered out of the Starred
      // view on next visit.
      unhideRow(id);
      if (parsed.folder !== "starred") {
        unhideRow(`starred:${parsed.uid}`);
      }
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, starred: nextStarred } : m)));
    }
    setDeepResults((prev) =>
      prev ? prev.map((m) => (m.id === id ? { ...m, starred: nextStarred } : m)) : prev,
    );
    const cached = messageCache.current.get(id);
    if (cached) messageCache.current.set(id, { ...cached, starred: nextStarred });
    try {
      await mutateFlag(parsed.folder, parsed.uid, "flagged", nextStarred);
      // IMAP + Local Index write-through succeeded. If we optimistically
      // hid a row in the Starred view, mark the hide as CONFIRMED so the
      // next primary list load (which is guaranteed to reflect the flag
      // flip) auto-drops it via gcHiddenBefore. A pre-mutation racing
      // response still can't resurrect the row in the meantime.
      if (starredFolderSnapshot) {
        confirmHideRow(id, Date.now());
      }
    } catch (err: unknown) {
      clearPendingFlagOverride(id, "starred");
      // Rollback counter with the inverse delta (single, exact revert).
      setCounts((prev) => {
        const cur = prev.starred;
        if (!cur) return prev;
        const delta = nextStarred ? -1 : 1;
        return { ...prev, starred: { ...cur, total: Math.max(0, cur.total + delta) } };
      });
      if (starredFolderSnapshot) {
        // Restore the row at its previous position, then unhide.
        // Duplicate guard: a racing sync may have already re-inserted
        // the row while the mutation was in flight — never insert twice.
        unhideRow(id);
        const { list, index } = starredFolderSnapshot;
        const revived = list[index];
        setMessages((prev) => {
          if (prev.some((m) => m.id === id)) return prev;
          const next = prev.slice();
          const clampedIdx = Math.min(index, next.length);
          next.splice(clampedIdx, 0, revived);
          return next;
        });
      } else {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, starred: !nextStarred } : m)));
      }
      setDeepResults((prev) =>
        prev ? prev.map((m) => (m.id === id ? { ...m, starred: !nextStarred } : m)) : prev,
      );
      const c = messageCache.current.get(id);
      if (c) messageCache.current.set(id, { ...c, starred: !nextStarred });
      toast.error(errorMessage(err, tr("فشل تحديث المميّز")));
    } finally {
      // V4: always release the star-count "hot" window, success or failure.
      endStarMutation();
    }
  }

  const handleInlineImagesResolved = useCallback(
    (messageId: string, images: NonNullable<MailMessage["inlineImages"]>) => {
      const current = messageCache.current.get(messageId);
      if (!current) return;
      const byCid = new Map(
        (current.inlineImages ?? []).map((image) => [image.cid.toLowerCase(), image]),
      );
      for (const image of images) byCid.set(image.cid.toLowerCase(), image);
      const updated = { ...current, inlineImages: [...byCid.values()] };
      messageCache.current.set(messageId, updated);
    },
    [],
  );

  const handleEntireBodyLoaded = useCallback((next: MailMessage) => {
    setSelectedMessage((current) => (samePhysicalMessage(current, next) ? next : current));
  }, []);

  async function toggleRead(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    const nextRead = !msg.read;
    setPendingFlagOverride(id, { read: nextRead });
    // Optimistic
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: nextRead } : m)));
    setDeepResults((prev) =>
      prev ? prev.map((m) => (m.id === id ? { ...m, read: nextRead } : m)) : prev,
    );
    const cached = messageCache.current.get(id);
    if (cached) messageCache.current.set(id, { ...cached, read: nextRead });
    setCounts((prev) => {
      const cur = prev[parsed.folder];
      if (!cur) return prev;
      const delta = nextRead ? -1 : 1;
      const unread = Math.max(0, cur.unread + delta);
      return { ...prev, [parsed.folder]: { ...cur, unread } };
    });
    try {
      await mutateFlag(parsed.folder, parsed.uid, "seen", nextRead);
    } catch (err: unknown) {
      // Revert both flag and counter.
      clearPendingFlagOverride(id, "read");
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: !nextRead } : m)));
      setDeepResults((prev) =>
        prev ? prev.map((m) => (m.id === id ? { ...m, read: !nextRead } : m)) : prev,
      );
      const c = messageCache.current.get(id);
      if (c) messageCache.current.set(id, { ...c, read: !nextRead });
      setCounts((prev) => {
        const cur = prev[parsed.folder];
        if (!cur) return prev;
        const delta = nextRead ? 1 : -1;
        const unread = Math.max(0, cur.unread + delta);
        return { ...prev, [parsed.folder]: { ...cur, unread } };
      });
      toast.error(errorMessage(err, tr("فشل تحديث حالة القراءة")));
    }
  }

  // Optimistic-count helper for Move/Trash/Restore. `from` decreases by 1
  // (and unread by 1 if the message was unread). `to` is symmetric. Both
  // clamp at 0 so a stale counter never goes negative.
  function applyMoveCountsDelta(from: MailFolder, to: MailFolder | null, wasUnread: boolean) {
    setCounts((prev) => {
      const next = { ...prev };
      const src = next[from];
      if (src) {
        next[from] = {
          ...src,
          total: Math.max(0, src.total - 1),
          unread: Math.max(0, src.unread - (wasUnread ? 1 : 0)),
        };
      }
      if (to && next[to]) {
        const d = next[to];
        next[to] = {
          ...d,
          total: d.total + 1,
          unread: d.unread + (wasUnread ? 1 : 0),
        };
      }
      return next;
    });
  }

  // Per-item revive helper (Batch B): re-inserts a single message into the
  // list at its original index with a duplicate guard so we never clobber a
  // concurrent mutation that already re-added the row, and never rebuild the
  // full list from a stale snapshot.
  function reviveMessageAt(original: MailMessage, originalIndex: number) {
    setMessages((prev) => reviveAt(prev, original, originalIndex));
  }

  function reviveDeepResultAt(original: MailMessage, originalIndex: number) {
    setDeepResults((prev) => (prev ? reviveAt(prev, original, originalIndex) : prev));
  }

  async function handleMove(id: string, toFolder: MailFolder) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    return runMoveFlight(id, async () => {
      // Batch B: capture per-item snapshot BEFORE optimistic mutation.
      const originalIndex = messages.findIndex((m) => m.id === id);
      const original = originalIndex >= 0 ? messages[originalIndex] : null;
      const wasUnread = original ? !original.read : false;
      const wasSelected = selectedId === id;
      const prevSelected = wasSelected ? selectedMessage : null;
      const cachedBody = messageCache.current.get(id);
      // Optimistic — hide row, drop selection if it was the moved one.
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (wasSelected) {
        setSelectedId(null);
        setSelectedMessage(null);
      }
      messageCache.current.delete(id);
      hideRow(id);
      beginPendingMove(
        id,
        toFolder === "trash" ? "trash" : toFolder === "archive" ? "archive" : "move",
      );
      applyMoveCountsDelta(parsed.folder, toFolder, wasUnread);
      try {
        const moveResult = await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder,
        });
        const destKind = originKindForDestination(toFolder);
        if (destKind) {
          writeOriginOnDestination({
            accountId: currentAccountId,
            destKind,
            sourceCanonical: parsed.folder,
            sourceUid: parsed.uid,
            messageId: original?.threadId ?? null,
            fingerprint: original ? fingerprintFromMessage(original) : null,
            moveResult,
          });
        }
        const srcKind = originKindForRestore(parsed.folder);
        if (srcKind) {
          forgetOriginForDestUid(
            srcKind,
            currentAccountId,
            parsed.uid,
            srcKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current,
          );
        }

        confirmHideRow(id);
        confirmPendingMove(id);
        toast.success(tr("تم نقل الرسالة"));
      } catch (err: unknown) {
        // Per-item rollback ONLY. Do not touch other messages that may have
        // changed concurrently.
        unhideRow(id);
        rollbackPendingMove(id);
        applyMoveCountsDelta(toFolder, parsed.folder, wasUnread); // revert
        if (original) reviveMessageAt(original, originalIndex);
        if (cachedBody) messageCache.current.set(id, cachedBody);
        if (wasSelected) {
          setSelectedId(id);
          if (prevSelected) setSelectedMessage(prevSelected);
        }
        toast.error(errorMessage(err, tr("فشل نقل الرسالة")));
      }
    });
  }

  async function handleDelete(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    const isTrash = parsed.folder === "trash";
    const confirmed = await confirm({
      title: isTrash ? tr("حذف نهائي") : tr("نقل إلى المهملات"),
      description: isTrash
        ? tr("هل أنت متأكد من حذف هذه الرسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.")
        : tr("هل أنت متأكد من نقل هذه الرسالة إلى المهملات؟"),
      confirmLabel: isTrash ? tr("حذف") : tr("نقل"),
      cancelLabel: tr("إلغاء"),
      variant: isTrash ? "destructive" : "default",
    });
    if (!confirmed) return;
    return runMoveFlight(id, async () => {
      // Batch B: per-item snapshot captured BEFORE optimistic mutation.
      const originalIndex = messages.findIndex((m) => m.id === id);
      const original = originalIndex >= 0 ? messages[originalIndex] : null;
      const wasUnread = original ? !original.read : false;
      const deepOriginalIndex = deepResults ? deepResults.findIndex((m) => m.id === id) : -1;
      const deepOriginal =
        deepOriginalIndex >= 0 && deepResults ? deepResults[deepOriginalIndex] : null;
      const wasSelected = selectedId === id;
      const prevSelected = wasSelected ? selectedMessage : null;
      const cachedBody = messageCache.current.get(id);
      const destForCounts: MailFolder | null = isTrash ? null : "trash";
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (isTrash) {
        setDeepResults((prev) => (prev ? prev.filter((m) => m.id !== id) : prev));
      }
      if (wasSelected) {
        setSelectedId(null);
        setSelectedMessage(null);
      }
      messageCache.current.delete(id);
      hideRow(id);
      beginPendingMove(id, isTrash ? "permanent-delete" : "trash");
      applyMoveCountsDelta(parsed.folder, destForCounts, wasUnread);
      try {
        if (isTrash) {
          await mutateMoveOrDelete({ sourceCanonical: parsed.folder, uid: parsed.uid });
          forgetOriginForDestUid(
            "trash",
            currentAccountId,
            parsed.uid,
            trashUidValidityRef.current,
          );
        } else {
          const moveResult = await mutateMoveOrDelete({
            sourceCanonical: parsed.folder,
            uid: parsed.uid,
            toFolder: "trash",
          });
          writeOriginOnDestination({
            accountId: currentAccountId,
            destKind: "trash",
            sourceCanonical: parsed.folder,
            sourceUid: parsed.uid,
            messageId: original?.threadId ?? null,
            fingerprint: original ? fingerprintFromMessage(original) : null,
            moveResult,
          });
          // If source was archive, drop its archive origin too.
          if (parsed.folder === "archive") {
            forgetOriginForDestUid(
              "archive",
              currentAccountId,
              parsed.uid,
              archiveUidValidityRef.current,
            );
          }
        }

        confirmHideRow(id);
        confirmPendingMove(id);
        toast.success(isTrash ? tr("تم حذف الرسالة نهائياً") : tr("تم نقل الرسالة إلى المهملات"));
      } catch (err: unknown) {
        unhideRow(id);
        rollbackPendingMove(id);
        applyMoveCountsDelta(destForCounts ?? parsed.folder, parsed.folder, wasUnread); // revert
        if (original) reviveMessageAt(original, originalIndex);
        if (isTrash && deepOriginal) reviveDeepResultAt(deepOriginal, deepOriginalIndex);
        if (cachedBody) messageCache.current.set(id, cachedBody);
        if (wasSelected) {
          setSelectedId(id);
          if (prevSelected) setSelectedMessage(prevSelected);
        }
        toast.error(
          errorMessage(err, isTrash ? tr("فشل حذف الرسالة") : tr("فشل نقل الرسالة إلى المهملات")),
        );
      }
    });
  }

  async function handleRestore(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    const restoreKind = originKindForRestore(parsed.folder);
    if (!restoreKind) return;
    const destUidValidity =
      restoreKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current;
    return runMoveFlight(id, async () => {
      // Batch B: per-item snapshot captured BEFORE optimistic mutation.
      const originalIndex = messages.findIndex((m) => m.id === id);
      const original = originalIndex >= 0 ? messages[originalIndex] : null;
      const wasUnread = original ? !original.read : false;
      const target = readOriginForDestUid(
        restoreKind,
        currentAccountId,
        parsed.uid,
        destUidValidity,
      );
      const wasSelected = selectedId === id;
      const prevSelected = wasSelected ? selectedMessage : null;
      const cachedBody = messageCache.current.get(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (wasSelected) {
        setSelectedId(null);
        setSelectedMessage(null);
      }
      messageCache.current.delete(id);
      hideRow(id);
      beginPendingMove(id, "restore");
      applyMoveCountsDelta(parsed.folder, target, wasUnread);
      try {
        await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder: target,
        });
        forgetOriginForDestUid(restoreKind, currentAccountId, parsed.uid, destUidValidity);
        confirmHideRow(id);
        confirmPendingMove(id);
        const label = FOLDER_META[target as MailFolder]?.label || target;
        toast.success(trf("تم استعادة الرسالة إلى {{folder}}", { folder: tr(label) }));
      } catch (err: unknown) {
        unhideRow(id);
        rollbackPendingMove(id);
        applyMoveCountsDelta(target, parsed.folder, wasUnread); // revert
        if (original) reviveMessageAt(original, originalIndex);
        if (cachedBody) messageCache.current.set(id, cachedBody);
        if (wasSelected) {
          setSelectedId(id);
          if (prevSelected) setSelectedMessage(prevSelected);
        }
        toast.error(errorMessage(err, tr("فشل استعادة الرسالة")));
      }
    });
  }

  async function handleMarkUnread(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    // BLOCKER_5 — complete rollback for handleMarkUnread on failure so a
    // failed IMAP flag write can't leave the UI (list row, counter, cache,
    // selection) permanently pretending the message is unread.
    const msg = messages.find((m) => m.id === id);
    if (!msg || !msg.read) return; // no-op if already unread
    const prevSelectedId = selectedId;
    const prevSelected = selectedMessage;
    const prevCache = messageCache.current.get(id);
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: false } : m)));
    setCounts((prev) => {
      const cur = prev[parsed.folder];
      if (!cur) return prev;
      return { ...prev, [parsed.folder]: { ...cur, unread: cur.unread + 1 } };
    });
    if (prevCache) messageCache.current.set(id, { ...prevCache, read: false });
    setSelectedId(null);
    setSelectedMessage(null);
    try {
      await mutateFlag(parsed.folder, parsed.uid, "seen", false);
    } catch (err: unknown) {
      // Full revert — row, counter, cache, selection.
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: true } : m)));
      setCounts((prev) => {
        const cur = prev[parsed.folder];
        if (!cur) return prev;
        return { ...prev, [parsed.folder]: { ...cur, unread: Math.max(0, cur.unread - 1) } };
      });
      if (prevCache) messageCache.current.set(id, prevCache);
      if (prevSelectedId === id) {
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
      }
      toast.error(errorMessage(err, tr("فشل التعليم كغير مقروءة")));
    }
  }

  function toggleSelect(id: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelection((prev) => {
      if (prev.size >= filteredMessages.length && filteredMessages.length > 0) {
        return new Set();
      }
      return new Set(filteredMessages.map((m) => m.id));
    });
  }

  function clearSelection() {
    setSelection(new Set());
  }

  function toggleSelectMode() {
    setSelectMode((v) => {
      if (v) clearSelection();
      return !v;
    });
  }

  // Run async ops with limited concurrency to stay fast without hammering the bridge
  async function runBatch<T>(items: T[], limit: number, worker: (item: T) => Promise<unknown>) {
    let idx = 0;
    let failed = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try {
          await worker(items[i]);
        } catch {
          failed++;
        }
      }
    });
    await Promise.all(runners);
    return { failed };
  }

  // Bulk helper: capture per-id metadata BEFORE we clear the selection or
  // filter the list, so a per-id rollback can rebuild counters correctly.
  // Bulk helper: capture per-id metadata BEFORE we clear the selection or
  // filter the list, so a per-id rollback can rebuild counters and re-insert
  // failed rows at their original indices.
  function collectBulkMeta(ids: string[]) {
    const set = new Set(ids);
    const meta = new Map<
      string,
      { threadId?: string; wasUnread: boolean; original: MailMessage; originalIndex: number }
    >();
    messages.forEach((m, idx) => {
      if (set.has(m.id))
        meta.set(m.id, {
          threadId: m.threadId,
          wasUnread: !m.read,
          original: m,
          originalIndex: idx,
        });
    });
    return meta;
  }

  async function bulkMove(toFolder: MailFolder) {
    if (!session || selection.size === 0 || bulkBusy) return;
    const ids = Array.from(selection);
    const meta = collectBulkMeta(ids);
    const prevSelectedId = selectedId;
    const prevSelected = selectedMessage;
    // Per-id cache snapshots so bulk-move rollback restores only the failed
    // items' bodies — successful items stay purged.
    const cachedBodies = new Map<string, MailMessage>();
    for (const id of ids) {
      const c = messageCache.current.get(id);
      if (c) cachedBodies.set(id, c);
    }
    setBulkBusy(true);
    setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
    if (prevSelectedId && selection.has(prevSelectedId)) {
      setSelectedId(null);
      setSelectedMessage(null);
    }
    const bulkOp: PendingMoveOperation =
      toFolder === "trash" ? "trash" : toFolder === "archive" ? "archive" : "move";
    ids.forEach((id) => {
      messageCache.current.delete(id);
      hideRow(id);
      beginPendingMove(id, bulkOp);
    });
    // Optimistic counter deltas per id (source folder inferred from id).
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (!parsed) continue;
      const info = meta.get(id);
      applyMoveCountsDelta(parsed.folder, toFolder, info?.wasUnread ?? false);
    }
    clearSelection();
    const failedIds: string[] = [];
    await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      try {
        const moveResult = await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder,
        });
        const destKind = originKindForDestination(toFolder);
        if (destKind) {
          writeOriginOnDestination({
            accountId: currentAccountId,
            destKind,
            sourceCanonical: parsed.folder,
            sourceUid: parsed.uid,
            messageId: meta.get(id)?.threadId ?? null,
            fingerprint: (() => {
              const o = meta.get(id)?.original;
              return o ? fingerprintFromMessage(o) : null;
            })(),
            moveResult,
          });
        }
        const srcKind = originKindForRestore(parsed.folder);
        if (srcKind) {
          forgetOriginForDestUid(
            srcKind,
            currentAccountId,
            parsed.uid,
            srcKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current,
          );
        }

        confirmHideRow(id);
        confirmPendingMove(id);
      } catch (err) {
        failedIds.push(id);
        throw err;
      }
    });
    setBulkBusy(false);
    if (failedIds.length > 0) {
      // Per-id rollback: restore rows + counters + cache for failed ids only.
      // Never touch successful items; never rebuild the full list.
      const failedSet = new Set(failedIds);
      for (const id of failedIds) {
        unhideRow(id);
        rollbackPendingMove(id);
        const parsed = parseMessageId(id);
        const info = meta.get(id);
        if (parsed && info) {
          applyMoveCountsDelta(toFolder, parsed.folder, info.wasUnread); // revert
        }
        if (info) reviveMessageAt(info.original, info.originalIndex);
        const cached = cachedBodies.get(id);
        if (cached) messageCache.current.set(id, cached);
      }
      if (prevSelectedId && failedSet.has(prevSelectedId)) {
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
      }
      toast.error(
        trf("فشل نقل {{failed}} من {{total}} رسالة", {
          failed: failedIds.length,
          total: ids.length,
        }),
      );
    } else {
      toast.success(trf("تم نقل {{count}} رسالة", { count: ids.length }));
    }
  }

  async function bulkDelete() {
    if (!session || selection.size === 0 || bulkBusy) return;
    const ids = Array.from(selection);
    const isTrash = folder === "trash";
    const confirmed = await confirm({
      title: isTrash ? tr("حذف نهائي") : tr("نقل إلى المهملات"),
      description: isTrash
        ? trf("هل أنت متأكد من حذف {{count}} رسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.", {
            count: ids.length,
          })
        : trf("هل أنت متأكد من نقل {{count}} رسالة إلى المهملات؟", { count: ids.length }),
      confirmLabel: isTrash ? tr("حذف") : tr("نقل"),
      cancelLabel: tr("إلغاء"),
      variant: isTrash ? "destructive" : "default",
    });
    if (!confirmed) return;
    const meta = collectBulkMeta(ids);
    // Per-id deep-result snapshot: capture index + row before the optimistic
    // filter so failed items can be re-inserted where they were.
    const deepMeta = new Map<string, { original: MailMessage; originalIndex: number }>();
    if (deepResults) {
      deepResults.forEach((m, idx) => {
        if (idSet.has(m.id)) deepMeta.set(m.id, { original: m, originalIndex: idx });
      });
    }

    const idSet = new Set(ids);
    const prevSelectedId = selectedId;
    const prevSelected = selectedMessage;
    // Per-id cache snapshots so bulk-delete rollback restores only the
    // failed items' bodies — successful items stay purged.
    const cachedBodies = new Map<string, MailMessage>();
    for (const id of ids) {
      const c = messageCache.current.get(id);
      if (c) cachedBodies.set(id, c);
    }
    setBulkBusy(true);
    setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
    if (isTrash) {
      setDeepResults((prev) => (prev ? prev.filter((m) => !idSet.has(m.id)) : prev));
    }
    if (prevSelectedId && selection.has(prevSelectedId)) {
      setSelectedId(null);
      setSelectedMessage(null);
    }
    const bulkDeleteOp: PendingMoveOperation = isTrash ? "permanent-delete" : "trash";
    ids.forEach((id) => {
      messageCache.current.delete(id);
      hideRow(id);
      beginPendingMove(id, bulkDeleteOp);
    });
    const destForCounts: MailFolder | null = isTrash ? null : "trash";
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (!parsed) continue;
      const info = meta.get(id);
      applyMoveCountsDelta(parsed.folder, destForCounts, info?.wasUnread ?? false);
    }
    clearSelection();
    const failedIds: string[] = [];
    await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      try {
        if (isTrash) {
          await mutateMoveOrDelete({ sourceCanonical: parsed.folder, uid: parsed.uid });
          forgetOriginForDestUid(
            "trash",
            currentAccountId,
            parsed.uid,
            trashUidValidityRef.current,
          );
        } else {
          const moveResult = await mutateMoveOrDelete({
            sourceCanonical: parsed.folder,
            uid: parsed.uid,
            toFolder: "trash",
          });
          writeOriginOnDestination({
            accountId: currentAccountId,
            destKind: "trash",
            sourceCanonical: parsed.folder,
            sourceUid: parsed.uid,
            messageId: meta.get(id)?.threadId ?? null,
            fingerprint: (() => {
              const o = meta.get(id)?.original;
              return o ? fingerprintFromMessage(o) : null;
            })(),
            moveResult,
          });
          if (parsed.folder === "archive") {
            forgetOriginForDestUid(
              "archive",
              currentAccountId,
              parsed.uid,
              archiveUidValidityRef.current,
            );
          }
        }

        confirmHideRow(id);
        confirmPendingMove(id);
      } catch (err) {
        failedIds.push(id);
        throw err;
      }
    });
    setBulkBusy(false);
    if (failedIds.length > 0) {
      const failedSet = new Set(failedIds);
      for (const id of failedIds) {
        unhideRow(id);
        rollbackPendingMove(id);
        const parsed = parseMessageId(id);
        const info = meta.get(id);
        if (parsed && info) {
          applyMoveCountsDelta(destForCounts ?? parsed.folder, parsed.folder, info.wasUnread); // revert
        }
        // Restore cached body for failed id only.
        const c = cachedBodies.get(id);
        if (c) messageCache.current.set(id, c);
        // Per-item revive into list + deep results (with duplicate guard).
        if (info) reviveMessageAt(info.original, info.originalIndex);
        if (isTrash) {
          const d = deepMeta.get(id);
          if (d) reviveDeepResultAt(d.original, d.originalIndex);
        }
      }

      if (prevSelectedId && failedSet.has(prevSelectedId)) {
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
      }
      toast.error(
        isTrash
          ? trf("فشل حذف {{failed}} من {{total}} رسالة", {
              failed: failedIds.length,
              total: ids.length,
            })
          : trf("فشل نقل {{failed}} من {{total}} رسالة إلى المهملات", {
              failed: failedIds.length,
              total: ids.length,
            }),
      );
    } else {
      toast.success(
        isTrash
          ? trf("تم حذف {{count}} رسالة", { count: ids.length })
          : trf("تم نقل {{count}} رسالة إلى المهملات", { count: ids.length }),
      );
    }
  }

  async function bulkRestore() {
    if (!session || selection.size === 0 || bulkBusy) return;
    const restoreKind = originKindForRestore(folder);
    if (!restoreKind) return;
    const destUidValidity =
      restoreKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current;
    const ids = Array.from(selection);
    const meta = collectBulkMeta(ids);
    const prevSelectedId = selectedId;
    const prevSelected = selectedMessage;
    const cachedBodies = new Map<string, MailMessage>();
    for (const id of ids) {
      const c = messageCache.current.get(id);
      if (c) cachedBodies.set(id, c);
    }
    setBulkBusy(true);

    setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
    if (prevSelectedId && selection.has(prevSelectedId)) {
      setSelectedId(null);
      setSelectedMessage(null);
    }
    ids.forEach((id) => {
      messageCache.current.delete(id);
      hideRow(id);
      beginPendingMove(id, "restore");
    });
    // Precompute targets from origin map for both delta application and rollback.
    const idToTarget = new Map<string, MailFolder>();
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (!parsed) continue;
      const target = readOriginForDestUid(
        restoreKind,
        currentAccountId,
        parsed.uid,
        destUidValidity,
      );
      idToTarget.set(id, target);
      applyMoveCountsDelta(parsed.folder, target, meta.get(id)?.wasUnread ?? false);
    }
    clearSelection();
    const failedIds: string[] = [];
    await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      const target = idToTarget.get(id)!;
      try {
        await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder: target,
        });
        forgetOriginForDestUid(restoreKind, currentAccountId, parsed.uid, destUidValidity);
        confirmHideRow(id);
        confirmPendingMove(id);
      } catch (err) {
        failedIds.push(id);
        throw err;
      }
    });
    setBulkBusy(false);
    if (failedIds.length > 0) {
      const failedSet = new Set(failedIds);
      for (const id of failedIds) {
        unhideRow(id);
        rollbackPendingMove(id);
        const parsed = parseMessageId(id);
        const info = meta.get(id);
        const target = idToTarget.get(id);
        if (parsed && info && target) {
          applyMoveCountsDelta(target, parsed.folder, info.wasUnread); // revert
        }
        if (info) reviveMessageAt(info.original, info.originalIndex);
        const cached = cachedBodies.get(id);
        if (cached) messageCache.current.set(id, cached);
      }

      if (prevSelectedId && failedSet.has(prevSelectedId)) {
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
      }
      toast.error(
        trf("فشل استعادة {{failed}} من {{total}} رسالة", {
          failed: failedIds.length,
          total: ids.length,
        }),
      );
    } else {
      toast.success(trf("تم استعادة {{count}} رسالة", { count: ids.length }));
    }
  }

  async function bulkMarkUnread() {
    if (!session || selection.size === 0 || bulkBusy) return;
    const ids = Array.from(selection);
    setBulkBusy(true);
    setMessages((prev) => prev.map((m) => (selection.has(m.id) ? { ...m, read: false } : m)));
    ids.forEach((id) => {
      const c = messageCache.current.get(id);
      if (c) messageCache.current.set(id, { ...c, read: false });
    });
    clearSelection();
    const { failed } = await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      await mutateFlag(parsed.folder, parsed.uid, "seen", false);
    });
    setBulkBusy(false);
    if (failed > 0) toast.error(trf("فشل تعليم {{count}} رسالة", { count: failed }));
    else toast.success(trf("تم تعليم {{count}} رسالة كغير مقروءة", { count: ids.length }));
    loadCountsSoft();
  }

  function loadCountsSoft() {
    // Refresh counters only — never touch messages or sort order.
    setTimeout(() => loadCounts(), 300);
  }

  function handleSignOut() {
    // Wipe pending-move overlay for this account so a subsequent sign-in
    // cannot inherit stale suppressions from the previous session.
    clearAllPendingMoves();
    // BLOCKER_6 — drop this account's origin map so a fresh sign-in on the
    // same device doesn't inherit stale restore targets.
    clearAccountOrigins(safeOriginStorage(), currentAccountId);

    // Address-book: wipe local suggestion cache so a new sign-in on the same
    // device starts fresh and never surfaces a previous scope's contacts.
    void wipeAllPersisted();

    resetAsyncScope(true);

    clearMailSession();
    navigate({ to: "/login" });
  }

  if (session === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!session) return null;

  const brandName = session.company?.app_name || session.company?.name || "MailMaestro";

  return (
    <div className="flex h-screen w-full flex-col bg-background">
      {bridgeError && (
        <div className="flex items-center justify-center gap-2 bg-warning px-3 py-2 text-xs font-medium text-warning-foreground">
          <AlertOctagon className="h-4 w-4" />
          <span>{tr("تعذّر الاتصال بخادم البريد. سنعيد المحاولة تلقائياً.")}</span>
          <button
            onClick={() => rawRefresh()}
            className="underline underline-offset-2 hover:opacity-80"
          >
            {tr("إعادة المحاولة الآن")}
          </button>
        </div>
      )}

      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4">
        <button
          onClick={() => setSidebarOpen((s) => !s)}
          className="rounded-lg p-2 hover:bg-muted lg:hidden"
          aria-label={tr("القائمة")}
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link to="/mail" className="flex shrink-0 items-center gap-1" dir="ltr">
          {session.company?.logo_url ? (
            <img
              src={session.company.logo_url}
              alt={brandName}
              className="h-8 w-8 rounded-lg object-contain"
            />
          ) : (
            <BrandLogo className="h-8 w-8" />
          )}
          <span className="hidden text-base font-bold sm:inline">{brandName}</span>
        </Link>

        <div
          className="mx-2 flex flex-1 items-center gap-1 rounded-xl bg-muted/70 pe-1 ps-3 py-1.5 transition focus-within:bg-card focus-within:shadow-elevated sm:mx-4 sm:max-w-xl"
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        >
          {searchMode === "deep" ? (
            deepLoading ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : (
              <Globe className="h-4 w-4 shrink-0 text-primary" />
            )
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              searchMode === "deep" ? tr("بحث شامل على السيرفر…") : tr("ابحث في البريد...")
            }
            className="w-full bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={tr("مسح")}
              aria-label={tr("مسح")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <DropdownMenu dir={uiDir} onOpenChange={setSearchDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                  searchMode === "deep"
                    ? "bg-primary/10 text-primary hover:bg-primary/15"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                title={tr("خيارات البحث")}
              >
                {searchMode === "deep" ? (
                  <Globe className="h-3.5 w-3.5" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">
                  {searchMode === "deep" ? tr("شامل") : tr("سريع")}
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
                {tr("نمط البحث")}
              </div>
              <DropdownMenuItem
                onSelect={() => setSearchMode("quick")}
                className="flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{tr("بحث سريع")}</span>
                    {searchMode === "quick" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tr("فوري في الرسائل المعروضة — دون أي طلب للسيرفر")}
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setSearchMode("deep")}
                className="flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{tr("بحث شامل على السيرفر")}</span>
                    {searchMode === "deep" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tr("IMAP SEARCH على كامل المجلد الحالي (الموضوع + المرسل + المستلمين)")}
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  if (searchMode !== "deep") setSearchMode("deep");
                  setDeepIncludeBody((v) => !v);
                }}
                className="flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border">
                  {deepIncludeBody && <Check className="h-3 w-3 text-primary" />}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{tr("تضمين نص الرسالة")}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tr("أبطأ لكنه يبحث داخل محتوى الرسائل أيضاً")}
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          {/* Mobile + tablet actions — collapse smoothly while the search field is focused */}
          <div
            className={`flex items-center gap-0.5 overflow-hidden transition-all duration-300 ease-out lg:hidden ${
              searchFocused || searchDropdownOpen ? "max-w-0 opacity-0" : "max-w-[6rem] opacity-100"
            }`}
          >
            <button
              onClick={refresh}
              disabled={refreshing}
              className="shrink-0 rounded-lg p-2 hover:bg-muted disabled:opacity-70"
              aria-label={tr("تحديث")}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
            </button>
            <MailboxSwitcher session={session} compact />
          </div>

          <div className="hidden lg:block">
            <MailboxSwitcher session={session} />
          </div>

          <button
            onClick={refresh}
            disabled={refreshing}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-70 lg:inline-flex"
            title={tr("تحديث البريد")}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
            <span className="hidden lg:inline">
              {refreshing ? tr("جاري التحديث...") : tr("تحديث")}
            </span>
          </button>
          <div className="hidden lg:block">
            <LanguageSwitcher />
          </div>
          <button
            onClick={handleSignOut}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive lg:inline-flex"
            title={tr("تسجيل الخروج")}
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden lg:inline">{tr("خروج")}</span>
          </button>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 start-0 top-14 z-30 flex w-64 shrink-0 transform flex-col border-e border-border bg-sidebar transition-transform lg:relative lg:top-0 lg:translate-x-0 ${
            sidebarOpen
              ? "translate-x-0"
              : `${uiDir === "rtl" ? "translate-x-full" : "-translate-x-full"} lg:translate-x-0`
          }`}
        >
          <div className="p-4">
            <button
              onClick={async () => {
                if (!(await guardComposerNav())) return;
                setCompose({});
                setSidebarOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-2xl bg-brand-gradient px-5 py-3.5 text-sm font-semibold text-white shadow-brand transition hover:scale-[1.02]"
            >
              <Pencil className="h-4 w-4" />
              {tr("رسالة جديدة")}
            </button>
          </div>

          <nav className="px-2">
            {(Object.keys(FOLDER_META) as MailFolder[])
              .filter((f) => counts[f]?.supported !== false)
              .map((f) => {
                const meta = FOLDER_META[f];
                const active = f === folder && !senderView;
                const Icon = meta.icon;
                const { total } = counts[f] || { total: 0 };
                return (
                  <button
                    key={f}
                    onClick={async () => {
                      if (!(await guardComposerNav())) return;
                      setSenderView(null);
                      setFolder(f);
                      setSelectedId(null);
                      setSelectedMessage(null);
                      setSidebarOpen(false);
                    }}
                    className={`mb-0.5 flex w-full items-center gap-3 rounded-e-full rounded-s-md px-4 py-2.5 text-sm transition ${
                      active
                        ? "bg-sidebar-hover font-semibold text-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-hover/60"
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${active ? "text-primary" : ""}`} />
                    <span className="flex-1 text-start">{tr(meta.label)}</span>
                    {total > 0 && (
                      <span
                        className={`rounded-full px-1.5 text-[11px] font-bold ${
                          active ? "text-primary" : "text-muted-foreground"
                        }`}
                      >
                        {total}
                      </span>
                    )}
                  </button>
                );
              })}

            {senderFolders.length > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {tr("المجلدات الخاصة")}
                </p>
                {senderFolders.map((sf) => {
                  const c = senderFolderColor(sf.color);
                  const active = senderView === sf.email;
                  return (
                    <button
                      key={sf.id}
                      onClick={async () => {
                        if (!(await guardComposerNav())) return;
                        setFolder("inbox");
                        setSenderView(sf.email);
                        setSelectedId(null);
                        setSelectedMessage(null);
                        setSidebarOpen(false);
                      }}
                      title={sf.email}
                      className={`mb-0.5 flex w-full items-center gap-3 rounded-e-full rounded-s-md px-4 py-2.5 text-sm transition ${
                        active
                          ? "bg-sidebar-hover font-semibold text-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-hover/60"
                      }`}
                    >
                      <FolderIcon className="h-4 w-4 shrink-0" style={{ color: c.hex }} />
                      <span className="flex-1 truncate text-start">{sf.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </nav>

          {/* Mobile + tablet footer: language + sign out live here instead of the top bar */}
          <div className="mt-auto border-t border-border p-3 lg:hidden">
            <div className="flex items-center justify-between gap-2">
              <LanguageSwitcher />
              <button
                onClick={handleSignOut}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
              >
                <LogOut className="h-4 w-4" />
                <span>{tr("خروج")}</span>
              </button>
            </div>
          </div>
        </aside>

        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 top-14 z-20 bg-black/40 lg:hidden"
          />
        )}

        {/* Message list */}
        <div
          className={`flex w-full flex-col border-e border-border bg-card md:w-96 md:shrink-0 ${
            compose || selectedMessage || (selectedId && reading) ? "hidden md:flex" : "flex"
          }`}
        >
          {selectMode || selection.size > 0 ? (
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-accent/40 px-4 text-xs">
              <button
                onClick={toggleSelectAllVisible}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted"
                title={
                  selection.size >= filteredMessages.length && filteredMessages.length > 0
                    ? tr("إلغاء التحديد")
                    : tr("تحديد الكل")
                }
              >
                {selection.size >= filteredMessages.length && filteredMessages.length > 0 ? (
                  <CheckSquare className="h-5 w-5 text-primary" />
                ) : selection.size > 0 ? (
                  <MinusSquare className="h-5 w-5 text-primary" />
                ) : (
                  <Square className="h-5 w-5 text-muted-foreground" />
                )}
              </button>
              <span className="font-semibold text-foreground">
                {selection.size > 0
                  ? trf("الرسائل المحددة", { count: selection.size })
                  : tr("اختر الرسائل")}
              </span>
              <div className="flex-1" />
              {bulkBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {selection.size > 0 && (
                <DropdownMenu dir={uiDir}>
                  <DropdownMenuTrigger asChild>
                    <button
                      disabled={bulkBusy}
                      className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                      title={tr("إجراءات")}
                    >
                      <MoreVertical className="h-4 w-4" />
                      <span>{tr("إجراءات")}</span>
                    </button>
                  </DropdownMenuTrigger>

                  <DropdownMenuContent align="start" className="w-56">
                    {(folder === "trash" || folder === "archive") && (
                      <>
                        <DropdownMenuItem
                          onClick={bulkRestore}
                          disabled={bulkBusy}
                          className="cursor-pointer hover:bg-accent focus:bg-accent"
                        >
                          <ArchiveRestore className="ms-2 h-4 w-4" />
                          {tr("استعادة المحدد")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      onClick={() => bulkMove("archive")}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <Archive className="ms-2 h-4 w-4" />
                      {tr("أرشفة المحدد")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => bulkMove("spam")}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <AlertOctagon className="ms-2 h-4 w-4" />
                      {tr("نقل إلى المزعج")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={bulkMarkUnread}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <MailIcon className="ms-2 h-4 w-4" />
                      {tr("تعليم كغير مقروءة")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={bulkDelete}
                      disabled={bulkBusy}
                      className="cursor-pointer text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:text-destructive"
                    >
                      <Trash2 className="ms-2 h-4 w-4" />
                      {folder === "trash" ? tr("حذف نهائياً") : tr("نقل إلى المهملات")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <button
                onClick={toggleSelectMode}
                disabled={bulkBusy}
                className="rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                title={tr("إلغاء التحديد")}
              >
                {tr("إلغاء")}
              </button>
            </div>
          ) : (
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4 text-xs">
              <div className="flex items-center gap-3">
                {selectMode && (
                  <button
                    onClick={toggleSelectAllVisible}
                    disabled={filteredMessages.length === 0}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
                    title={tr("تحديد الكل")}
                  >
                    <Square className="h-5 w-5 text-muted-foreground" />
                  </button>
                )}
                <span className="font-semibold text-muted-foreground">
                  {inDeepSearch ? (
                    <span className="flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5 text-primary" />
                      <span>
                        {tr("نتائج السيرفر")} · {filteredMessages.length}
                        {deepIncludeBody && (
                          <span className="ms-1 text-[10px] text-primary/70">
                            {tr("(يشمل المحتوى)")}
                          </span>
                        )}
                      </span>
                    </span>
                  ) : (
                    <>
                      {tr("المعروضة")} · {filteredMessages.length}
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {effectiveLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                <button
                  onClick={toggleSelectMode}
                  className={`rounded px-2 py-1.5 text-xs font-medium transition ${
                    selectMode
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "text-foreground hover:bg-muted"
                  }`}
                >
                  {selectMode ? tr("إلغاء") : tr("تحديد")}
                </button>
                {!inDeepSearch && (
                  <DropdownMenu dir={uiDir}>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                        title={tr("ترتيب العرض")}
                      >
                        <ArrowUpDown className="h-3.5 w-3.5" />
                        <span>{tr("ترتيب")}</span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {(
                        [
                          { value: "date-desc", label: tr("الأحدث أولاً") },
                          { value: "date-asc", label: tr("الأقدم أولاً") },
                          { value: "unread-first", label: tr("غير المقروءة أولاً") },
                          { value: "starred-first", label: tr("المميّزة بنجمة أولاً") },
                        ] as { value: SortOption; label: string }[]
                      ).map((opt, i) => {
                        const disabled = folder === "starred" && opt.value === "starred-first";
                        return (
                          <div key={opt.value}>
                            {i > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuItem
                              disabled={disabled}
                              onClick={() => !disabled && setSort(opt.value)}
                              className="flex items-center justify-between gap-2 hover:bg-accent focus:bg-accent"
                            >
                              <span>{opt.label}</span>
                              {sort === opt.value && <Check className="h-4 w-4 text-primary" />}
                            </DropdownMenuItem>
                          </div>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            {(effectiveLoading || (inDeepSearch && deepLoading)) &&
            filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                {inDeepSearch && (
                  <p className="text-xs text-muted-foreground">{tr("جاري البحث على السيرفر…")}</p>
                )}
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MailIcon className="h-10 w-10 opacity-30" />
                {inDeepSearch ? (
                  <>
                    <p className="text-sm">
                      {deepError ? deepError : tr("لا توجد نتائج على السيرفر")}
                    </p>
                    {!deepError && !deepIncludeBody && (
                      <p className="text-[11px] text-muted-foreground/70">
                        {tr("جرّب تفعيل «تضمين نص الرسالة» من خيارات البحث")}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm">{tr("لا توجد رسائل هنا")}</p>
                )}
              </div>
            ) : (
              <Virtuoso
                style={{ height: "100%" }}
                data={filteredMessages}
                overscan={800}
                increaseViewportBy={{ top: 400, bottom: 800 }}
                computeItemKey={(_, m) => m.id}
                endReached={() => {
                  if (
                    listPaginationReady &&
                    !effectiveLoading &&
                    hasMore &&
                    !loadingMore &&
                    !query.trim() &&
                    !inDeepSearch
                  )
                    void loadMore();
                }}
                itemContent={(_, m) => (
                  <MessageRow
                    message={m}
                    active={m.id === selectedId}
                    selected={selection.has(m.id)}
                    anySelected={selection.size > 0}
                    selectMode={selectMode}
                    onClick={() => {
                      if (selectMode) toggleSelect(m.id);
                      else openMessage(m.id);
                    }}
                    onToggleStar={(e) => toggleStar(e, m.id)}
                    onToggleRead={(e) => toggleRead(e, m.id)}
                    onToggleSelect={() => toggleSelect(m.id)}
                    onPrefetch={() => scheduleHoverPrefetch(m.id)}
                    onCancelPrefetch={() => cancelHoverPrefetch(m.id)}
                    onImmediatePrefetch={() => {
                      cancelHoverPrefetch(m.id);
                      // Speculative pointer-down intent is background work: it
                      // must never run on the interactive lane, where it would
                      // delay an explicit open or occupy the user's gate quota.
                      if (widePrefetch) void prefetchMessage(m.id, "adjacent", false, "background");
                    }}
                    senderFolderColorKey={senderFolderMap.get(m.from.email.toLowerCase())?.color}
                    onSenderFolder={() => openSenderFolderDialog(m)}
                  />
                )}
                components={{
                  Footer: () =>
                    loadingMore ? (
                      <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> {tr("جاري تحميل المزيد…")}
                      </div>
                    ) : !hasMore && filteredMessages.length > 0 ? (
                      <div className="py-4 text-center text-[11px] text-muted-foreground">
                        {tr("— نهاية الرسائل —")}
                      </div>
                    ) : null,
                }}
              />
            )}
          </div>
        </div>

        {/* Message viewer */}
        <div
          className={`flex-1 overflow-hidden bg-white ${
            compose || selectedMessage || (selectedId && reading) ? "flex" : "hidden md:flex"
          } flex-col`}
        >
          {compose ? (
            <Composer
              key={
                compose.editDraftId
                  ? `draft-edit:${compose.editDraftId}:${draftEditComposeNonce}`
                  : undefined
              }
              session={session}
              initial={compose}
              onClose={({ refreshDrafts }) => {
                setCompose(null);
                if (refreshDrafts) {
                  void (async () => {
                    await refreshAfterComposerClose();
                    if (folder === "drafts") await refreshWorkingDrafts();
                  })();
                }
              }}
              onSent={onAfterSend}
              onDraftCreated={onDraftCreated}
              onDraftSaved={handleDraftSaved}
              onDraftDeleteStart={handleDraftDeleteStart}
              onDraftDeleteRollback={handleDraftDeleteRollback}
              onDraftDeleted={handleDraftDeleted}
            />
          ) : selectedMessage ? (
            <MessageView
              message={selectedMessage}
              loading={reading}
              onInlineImages={handleInlineImagesResolved}
              onEntireBody={handleEntireBodyLoaded}
              onOpenHistorical={openHistoricalMessage}
              myEmail={session.account.email_address}
              onBack={() => {
                navigationGenerationRef.current?.invalidate();
                setSelectedId(null);
                setSelectedMessage(null);
                setReading(false);
              }}
              onReply={() => {
                setCompose(
                  buildReply(
                    selectedMessage,
                    session.account.email_address,
                    false,
                    deriveAttachmentSourceRef(selectedMessage, folderPaths),
                  ),
                );
              }}
              onReplyAll={() => {
                setCompose(
                  buildReply(
                    selectedMessage,
                    session.account.email_address,
                    true,
                    deriveAttachmentSourceRef(selectedMessage, folderPaths),
                  ),
                );
              }}
              onForward={() => {
                const next = buildForward(
                  selectedMessage,
                  deriveAttachmentSourceRef(selectedMessage, folderPaths),
                );
                if (!next) {
                  toast.error(tr("تعذّر تجهيز مرفقات الرسالة"));
                  return;
                }
                setCompose(next);
              }}
              onArchive={() => handleMove(selectedMessage.id, "archive")}
              onDelete={() => handleDelete(selectedMessage.id)}
              onSpam={() => handleMove(selectedMessage.id, "spam")}
              onMarkUnread={() => handleMarkUnread(selectedMessage.id)}
              onRestore={() => handleRestore(selectedMessage.id)}
              onPrint={() => {
                /* handled inside MessageView */
              }}
              onComposeFor={(msg, mode) => {
                const next =
                  mode === "forward"
                    ? buildForward(msg, deriveAttachmentSourceRef(msg, folderPaths))
                    : buildReply(
                        msg,
                        session.account.email_address,
                        mode === "replyAll",
                        deriveAttachmentSourceRef(msg, folderPaths),
                      );
                if (!next) {
                  toast.error(tr("تعذّر تجهيز مرفقات الرسالة"));
                  return;
                }
                setCompose(next);
              }}
            />
          ) : selectedId && reading ? (
            <LoadingViewer
              onBack={() => {
                navigationGenerationRef.current?.invalidate();
                setSelectedId(null);
                setSelectedMessage(null);
                setReading(false);
              }}
            />
          ) : (
            <EmptyViewer />
          )}
        </div>
      </div>

      {senderDialog && (
        <SenderFolderDialog
          open
          onOpenChange={(o) => {
            if (!o) setSenderDialog(null);
          }}
          email={senderDialog.email}
          initialName={senderDialog.name}
          initialColor={senderDialog.color}
          existing={senderDialog.existing}
          busy={senderDialogBusy}
          onSave={async (draft) => {
            setSenderDialogBusy(true);
            const ok = await upsertSenderFolder(draft);
            setSenderDialogBusy(false);
            if (ok) {
              setSenderDialog(null);
              toast.success(tr("تم حفظ المجلد"));
            } else {
              toast.error(tr("تعذر حفظ المجلد"));
            }
          }}
          onDelete={async () => {
            setSenderDialogBusy(true);
            const ok = await removeSenderFolder(senderDialog.email);
            setSenderDialogBusy(false);
            if (ok) {
              setSenderDialog(null);
              toast.success(tr("تم حذف المجلد"));
            } else {
              toast.error(tr("تعذر حذف المجلد"));
            }
          }}
        />
      )}
    </div>
  );
}

function MessageRow({
  message,
  active,
  selected,
  anySelected,
  selectMode,
  onClick,
  onToggleStar,
  onToggleRead,
  onToggleSelect,
  onPrefetch,
  onCancelPrefetch,
  onImmediatePrefetch,
  senderFolderColorKey,
  onSenderFolder,
}: {
  message: MailMessage;
  active: boolean;
  selected: boolean;
  anySelected: boolean;
  selectMode: boolean;
  onClick: () => void;
  onToggleStar: (e: React.MouseEvent) => void;
  onToggleRead: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
  onPrefetch: () => void;
  onCancelPrefetch: () => void;
  onImmediatePrefetch: () => void;
  /** Color key when this sender already has a folder, else undefined. */
  senderFolderColorKey?: string;
  onSenderFolder: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onPointerEnter={onPrefetch}
      onPointerLeave={onCancelPrefetch}
      onPointerDown={onImmediatePrefetch}
      onFocus={onPrefetch}
      onBlur={onCancelPrefetch}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-current={active ? "true" : undefined}
      className={`group relative flex w-full cursor-pointer items-start gap-3 border-b border-border/60 px-4 py-3 text-start transition-colors duration-150 active:duration-75 ${
        active
          ? "bg-primary/10 before:absolute before:inset-y-0 before:start-0 before:w-[3px] before:bg-primary before:content-['']"
          : selected
            ? "bg-primary/5 hover:bg-primary/10"
            : `${!message.read ? "bg-card" : "bg-card/70"} hover:bg-muted/50 active:bg-muted`
      }`}
    >
      {/* Avatar doubles as selection checkbox so no extra layout shift occurs */}
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white transition ${
            selectMode || selected ? "opacity-0" : "opacity-100"
          }`}
        >
          {message.from.name.charAt(0) || message.from.email.charAt(0)}
        </div>
        <div
          role="checkbox"
          aria-checked={selected}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onToggleSelect();
            }
          }}
          className={`absolute inset-0 z-10 flex items-center justify-center rounded-full transition ${
            selectMode || selected ? "opacity-100" : "opacity-0"
          }`}
          title={selected ? tr("إلغاء التحديد") : tr("تحديد")}
        >
          {selected ? (
            <CheckSquare className="h-5 w-5 text-primary" />
          ) : (
            <Square className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="mb-0.5 flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${
              !message.read ? "font-bold text-foreground" : "font-medium text-foreground/80"
            }`}
          >
            {message.from.name || message.from.email}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDate(message.date, getCurrentLang())}
          </span>
        </div>
        <p
          className={`truncate text-sm ${
            !message.read ? "font-semibold text-foreground" : "text-muted-foreground"
          }`}
        >
          {message.subject}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{message.preview}</p>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar(e);
            }}
            className={`rounded p-0.5 hover:bg-muted ${message.starred ? "text-star" : "text-muted-foreground"}`}
            title={message.starred ? tr("إزالة المميّز") : tr("تمييز")}
          >
            <Star className={`h-3.5 w-3.5 ${message.starred ? "fill-star" : ""}`} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleRead(e);
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={message.read ? tr("تعليم كغير مقروءة") : tr("تعليم كمقروءة")}
          >
            {message.read ? (
              <MailIcon className="h-3.5 w-3.5" />
            ) : (
              <MailOpen className="h-3.5 w-3.5" />
            )}
          </button>
          {message.hasAttachments && <Paperclip className="h-3 w-3 text-muted-foreground" />}
          {message.labels?.map((l) => (
            <span
              key={l}
              className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground"
            >
              {l}
            </span>
          ))}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSenderFolder(e);
            }}
            className="ms-auto rounded p-0.5 text-muted-foreground opacity-70 transition hover:bg-muted hover:text-foreground hover:opacity-100"
            title={
              senderFolderColorKey
                ? tr("إدارة المجلد الخاص بهذا المرسل")
                : tr("إنشاء مجلد خاص لهذا المرسل")
            }
          >
            {senderFolderColorKey ? (
              <FolderIcon
                className="h-3.5 w-3.5"
                style={{ color: senderFolderColor(senderFolderColorKey).hex }}
              />
            ) : (
              <FolderPlus className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Attachment block bound to ONE message (same visual language as the
 * composer's attachment area). Reused by the open message and by every
 * previous message of the conversation, so each turn shows its own files.
 */
function MessageAttachmentsSection({ message }: { message: MailMessage }) {
  const items = message.attachments ?? [];
  if (!items.length) return null;
  const total = items.reduce((s, a) => s + (a.size || 0), 0);
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <div className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{trf("المرفقات · {{size}}", { size: formatSize(total) })}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((a) => (
          <AttachmentCard key={a.id} attachment={a} message={message} />
        ))}
      </div>
    </div>
  );
}

export type ThreadComposeMode = "reply" | "replyAll" | "forward";

/** Compact recipient summary shown on a collapsed / expanded thread card. */
function ThreadRecipients({ message }: { message: MailMessage }) {
  const to = message.to.map((t) => t.email).filter(Boolean);
  const cc = (message.cc ?? []).map((c) => c.email).filter(Boolean);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1 text-[11px]">
      <dt className="whitespace-nowrap text-foreground/60">{tr("المرسل:")}</dt>
      <dd className="min-w-0 break-all">
        {message.from.name ? <span className="me-1">{message.from.name}</span> : null}
        <span dir="ltr" className="text-muted-foreground unicode-bidi-isolate">
          &lt;{message.from.email || "—"}&gt;
        </span>
      </dd>
      <dt className="whitespace-nowrap text-foreground/60">{tr("المستلم:")}</dt>
      <dd className="min-w-0 break-all">
        <span dir="ltr" className="unicode-bidi-isolate">
          {to.length ? to.join(", ") : "—"}
        </span>
      </dd>
      {cc.length > 0 && (
        <>
          <dt className="whitespace-nowrap text-foreground/60">{tr("نسخة:")}</dt>
          <dd className="min-w-0 break-all">
            <span dir="ltr" className="unicode-bidi-isolate">
              {cc.join(", ")}
            </span>
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * Shared reply / reply-all / forward buttons used both inside thread cards
 * and below the currently opened message. Keeps the exact same style, size
 * and focus behaviour everywhere.
 */
function MessageReplyButtons({
  onReply,
  onReplyAll,
  onForward,
  className,
}: {
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  className?: string;
}) {
  const btn =
    "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-muted active:border-transparent active:bg-primary active:text-primary-foreground focus-visible:border-transparent focus-visible:bg-primary focus-visible:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      <button type="button" onClick={onReply} className={btn}>
        <Reply className="h-3.5 w-3.5" /> {tr("رد")}
      </button>
      <button type="button" onClick={onReplyAll} className={btn}>
        <ReplyAll className="h-3.5 w-3.5" /> {tr("رد على الكل")}
      </button>
      <button type="button" onClick={onForward} className={btn}>
        <Forward className="h-3.5 w-3.5" /> {tr("إعادة توجيه")}
      </button>
    </div>
  );
}

/**
 * One previous message of the thread rendered as its own collapsible tab.
 * Collapsed by default: only the local index header row is rendered (zero
 * network). The body + attachments are fetched lazily on click through the
 * SAME cache-first open path, and reply/forward act on THAT message.
 */
type HistoricalOpenAttempt =
  | { kind: "memory"; message: MailMessage }
  | { kind: "pending"; promise: Promise<MailMessage | null> }
  | { kind: "error" };

function conversationRowBase(row: ConversationRow): MailMessage {
  const id = `${row.folder}:${row.uid}`;
  return {
    id,
    threadId: row.messageId ?? id,
    uidValidity: row.uidValidity,
    folder: row.folder,
    from: row.from,
    to: row.to,
    cc: row.cc?.length ? row.cc : undefined,
    subject: row.subject,
    preview: "",
    body: "",
    date: row.date,
    read: row.seen,
    starred: row.flagged,
    hasAttachments: row.hasAttachments,
  };
}

function ConversationMessageCard({
  row,
  onCompose,
  onOpenHistorical,
}: {
  row: ConversationRow;
  onCompose?: (message: MailMessage, mode: ThreadComposeMode) => void;
  onOpenHistorical: (row: ConversationRow) => HistoricalOpenAttempt;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<MailMessage | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const historicalBody = useMemo(
    () => trimHistoricalQuotedContent(loaded?.body || loaded?.preview || ""),
    [loaded?.body, loaded?.preview],
  );

  const shortDate = new Date(row.date).toLocaleString(
    getCurrentLang() === "ar" ? "ar-SA" : "en-GB",
    { dateStyle: "medium", timeStyle: "short" },
  );
  const toPreview = row.to
    .map((t) => t.email)
    .filter(Boolean)
    .join(", ");

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (loaded || state === "loading") return;
    const session = getMailSession();
    if (!session?.mailSessionToken) {
      setState("error");
      return;
    }
    const attempt = onOpenHistorical(row);
    if (attempt.kind === "memory") {
      setLoaded(attempt.message);
      setState("idle");
      return;
    }
    if (attempt.kind === "error") {
      setState("error");
      return;
    }
    setState("loading");
    try {
      const message = await attempt.promise;
      if (!message) {
        setState("error");
        return;
      }
      setLoaded(message);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border-2 transition-colors ${
        open ? "border-primary/40 bg-card shadow-sm" : "border-border bg-card/50 hover:bg-muted/40"
      }`}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex w-full items-start gap-3 px-3 py-2.5 text-start transition-colors ${
          open ? "bg-primary/[0.05]" : ""
        }`}
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[11px] font-bold text-white">
          {(row.from.name || row.from.email || "?").charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {row.from.name || row.from.email}
            </span>
            {row.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 opacity-60" />}
            <span className="shrink-0 text-xs text-muted-foreground">{shortDate}</span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            <span className="text-foreground/60">{tr("إلى")} </span>
            <span dir="ltr" className="unicode-bidi-isolate">
              {toPreview || "—"}
            </span>
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-3 pb-3">
          {state === "loading" && (
            <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {tr("جارٍ التحميل…")}
            </div>
          )}

          {state === "error" && (
            <div className="py-3 text-xs text-destructive">{tr("تعذّر تحميل الرسالة")}</div>
          )}
          {loaded && (
            <>
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5">
                <ThreadRecipients message={loaded} />
              </div>
              <MessageBody
                message={loaded}
                html={historicalBody}
                onEntireBody={(next) =>
                  setLoaded((current) => (samePhysicalMessage(current, next) ? next : current))
                }
                className="mt-3"
                suppressQuoted
                afterLatest={<MessageAttachmentsSection message={loaded} />}
              />
              {onCompose && (
                <MessageReplyButtons
                  className="mt-4 border-t border-border pt-3"
                  onReply={() => onCompose(loaded, "reply")}
                  onReplyAll={() => onCompose(loaded, "replyAll")}
                  onForward={() => onCompose(loaded, "forward")}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Loads the sibling rows of a conversation from the LOCAL INDEX only.
 * Deferred to an idle callback after the open path finished, so it never
 * competes with body rendering. Returns `null` while unknown.
 */
function useConversationRows(messageId: string): ConversationRow[] | null {
  const listConversation = useMailServerFn(listMailConversation);
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const session = getMailSession();
  const mailSessionToken = session?.mailSessionToken ?? "";
  const sessionScope = session
    ? `${session.company?.id ?? session.account.company_id}:${session.account.id}`
    : "";

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    const parsed = parseMessageId(messageId);
    if (!mailSessionToken || !parsed) {
      setRows([]);
      return;
    }
    const run = () => {
      listConversation({
        data: {
          mailSessionToken,

          folder: parsed.folder,
          uid: parsed.uid,
        },
      })
        .then((res) => {
          if (!cancelled) setRows(res.ok ? res.rows : []);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        });
    };
    const idle = (
      window as unknown as { requestIdleCallback?: (cb: () => void, o?: object) => number }
    ).requestIdleCallback;
    const handle = idle ? idle(run, { timeout: 800 }) : window.setTimeout(run, 120);
    return () => {
      cancelled = true;
      const cancelIdle = (window as unknown as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback;
      if (idle && cancelIdle) cancelIdle(handle as number);
      else window.clearTimeout(handle as number);
    };
  }, [mailSessionToken, messageId, listConversation, sessionScope]);

  return rows;
}

/**
 * Real thread history: the previous messages of the conversation, each as its
 * own collapsible tab with its own recipients, attachments and actions.
 * Newest first, directly under the currently open message.
 */
function ConversationHistory({
  rows,
  onCompose,
  onOpenHistorical,
}: {
  rows: ConversationRow[];
  onCompose?: (message: MailMessage, mode: ThreadComposeMode) => void;
  onOpenHistorical: (row: ConversationRow) => HistoricalOpenAttempt;
}) {
  const ordered = useMemo(
    () => [...rows].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [rows],
  );
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-col gap-3">
        <span className="h-px w-full bg-border" />
        <div className="flex items-center gap-2 text-foreground">
          <History className="h-4 w-4 text-primary" />
          <span className="whitespace-nowrap text-sm font-semibold">
            {trf("الرسائل السابقة ({{count}})", { count: ordered.length })}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {ordered.map((row) => (
          <ConversationMessageCard
            key={`${row.folder}:${row.uid}:${row.uidValidity}`}
            row={row}
            onCompose={onCompose}
            onOpenHistorical={onOpenHistorical}
          />
        ))}
      </div>
    </div>
  );
}

function MessageView({
  message,
  loading,
  onInlineImages,
  onEntireBody,
  onOpenHistorical,
  myEmail,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
  onSpam,
  onMarkUnread,
  onRestore,
  onPrint,
  onComposeFor,
}: {
  message: MailMessage;
  loading: boolean;
  onInlineImages: (messageId: string, images: NonNullable<MailMessage["inlineImages"]>) => void;
  onEntireBody: (message: MailMessage) => void;
  onOpenHistorical: (row: ConversationRow) => HistoricalOpenAttempt;
  myEmail: string;
  onBack: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSpam: () => void;
  onMarkUnread: () => void;
  onRestore: () => void;
  onPrint: () => void;
  onComposeFor?: (message: MailMessage, mode: ThreadComposeMode) => void;
}) {
  const { dir: uiDir } = useLanguage();
  const conversationRows = useConversationRows(message.id);
  const threadRows = useMemo(
    () =>
      conversationRows
        ? prepareConversationHistory(conversationRows, {
            id: message.id,
            uidValidity: message.uidValidity,
            date: message.date,
          })
        : null,
    [conversationRows, message.date, message.id, message.uidValidity],
  );
  const hasThreadRows = !!threadRows?.length;
  const [detailsOpen, setDetailsOpen] = useState(false);

  const recipientsAll = [
    ...message.to.map((t) => ({ ...t, kind: "to" as const })),
    ...(message.cc || []).map((c) => ({ ...c, kind: "cc" as const })),
  ];
  const toSummary =
    recipientsAll.length > 0 ? recipientsAll.map((r) => r.email).join(tr("،")) : "—";

  const fullDate = new Date(message.date).toLocaleString(
    getCurrentLang() === "ar" ? "ar-SA" : "en-GB",
    {
      dateStyle: "full",
      timeStyle: "short",
    },
  );
  const isTrash = message.folder === "trash";
  const canRestore = message.folder === "trash" || message.folder === "archive";
  const canArchive = message.folder !== "archive" && message.folder !== "trash";

  const isSecure = !!message.security && !/غير/.test(message.security);
  // The bridge emits Arabic security text; localize it at render time.
  const securityLabel = message.security
    ? isSecure
      ? `${tr("مشفّر")} (${(message.security.match(/\(([^)]+)\)/)?.[1] ?? "TLS").toUpperCase()})`
      : tr("غير مشفّر")
    : "";
  const handleInlineImages = useCallback(
    (images: NonNullable<MailMessage["inlineImages"]>) => onInlineImages(message.id, images),
    [message.id, onInlineImages],
  );

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(message.from.email);
      toast.success(tr("تم نسخ البريد"));
    } catch {
      toast.error(tr("تعذّر النسخ"));
    }
  }

  function printMessage() {
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) {
      toast.error(tr("تعذّر فتح نافذة الطباعة"));
      return;
    }
    const esc = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
      );
    const subject = esc(message.subject || tr("(بدون موضوع)"));
    const fromName = esc(message.from.name || message.from.email);
    const fromEmail = esc(message.from.email);
    const to = esc(message.to.map((t) => t.email).join(", "));
    const cc =
      message.cc && message.cc.length > 0 ? esc(message.cc.map((c) => c.email).join(", ")) : "";
    const date = esc(new Date(message.date).toLocaleString(getCurrentLang()));
    const body = message.body ? sanitizeEmailHtml(message.body) : esc(message.preview);
    win.document
      .write(`<!doctype html><html dir="${getCurrentLang() === "ar" ? "rtl" : "ltr"}" lang="${getCurrentLang()}"><head><meta charset="utf-8"><title>${subject}</title>
<style>
  body{font-family:'IBM Plex Sans Arabic',system-ui,sans-serif;color:#111;padding:24px;line-height:1.6}
  h1{font-size:20px;margin:0 0 16px}
  .meta{font-size:12px;color:#555;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:16px}
  .meta div{margin:2px 0}
  .body{font-size:14px}
  img{max-width:100%;height:auto}
  a{color:#0645ad;word-break:break-all}
</style></head><body>
<h1>${subject}</h1>
<div class="meta">
  <div><strong>${tr("المرسل:")}</strong> ${fromName} &lt;${fromEmail}&gt;</div>
  <div><strong>${tr("المستلم:")}</strong> <span dir="ltr">${to}</span></div>
  ${cc ? `<div><strong>${tr("نسخة:")}</strong> <span dir="ltr">${cc}</span></div>` : ""}
  <div><strong>${tr("التاريخ:")}</strong> ${date}</div>
</div>
<div class="body">${body}</div>
<script>window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`);
    win.document.close();
  }

  return (
    <>
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
          aria-label={tr("رجوع")}
        >
          <ChevronBackward className="h-4 w-4" /> {tr("رجوع")}
        </button>
        <div className="hidden gap-1 md:flex">
          <button onClick={onReply} className="rounded-lg p-2 hover:bg-muted" title={tr("رد")}>
            <Reply className="h-4 w-4" />
          </button>
          <button
            onClick={onReplyAll}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("رد على الكل")}
          >
            <ReplyAll className="h-4 w-4" />
          </button>
          <button
            onClick={onForward}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("إعادة توجيه")}
          >
            <Forward className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          {canRestore && (
            <button
              onClick={onRestore}
              className="rounded-lg p-2 hover:bg-muted"
              title={tr("استعادة إلى المجلد الأصلي")}
            >
              <ArchiveRestore className="h-4 w-4" />
            </button>
          )}

          {canArchive && (
            <button
              onClick={onArchive}
              className="rounded-lg p-2 hover:bg-muted"
              title={tr("أرشفة")}
            >
              <Archive className="h-4 w-4" />
            </button>
          )}
          <button onClick={onSpam} className="rounded-lg p-2 hover:bg-muted" title={tr("مزعج")}>
            <AlertOctagon className="h-4 w-4" />
          </button>
          <button
            onClick={onMarkUnread}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("تعليم كغير مقروءة")}
          >
            <MailOpen className="h-4 w-4" />
          </button>
          <button
            onClick={printMessage}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("طباعة")}
          >
            <Printer className="h-4 w-4" />
          </button>
          <button
            onClick={copyEmail}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("نسخ عنوان المرسل")}
          >
            <Copy className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          <button
            onClick={onDelete}
            className="rounded-lg p-2 text-destructive hover:bg-destructive/10"
            title={isTrash ? tr("حذف نهائي") : tr("نقل إلى المهملات")}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <DropdownMenu dir={uiDir}>
          <DropdownMenuTrigger asChild>
            <button className="rounded-lg p-2 hover:bg-muted" aria-label={tr("خيارات أكثر")}>
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="w-56 [&_[role=menuitem]]:flex-row [&_[role=menuitem]]:justify-start [&_[role=menuitem]]:text-start"
          >
            <DropdownMenuItem onClick={onReply}>
              <Reply className="h-4 w-4" /> {tr("رد")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReplyAll}>
              <ReplyAll className="h-4 w-4" /> {tr("رد على الكل")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onForward}>
              <Forward className="h-4 w-4" /> {tr("إعادة توجيه")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onMarkUnread}>
              <MailOpen className="h-4 w-4" /> {tr("تعليم كغير مقروءة")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={printMessage}>
              <Printer className="h-4 w-4" /> {tr("طباعة")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyEmail}>
              <Copy className="h-4 w-4" /> {tr("نسخ عنوان المرسل")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {canRestore && (
              <DropdownMenuItem onClick={onRestore}>
                <ArchiveRestore className="h-4 w-4" /> {tr("استعادة إلى المجلد الأصلي")}
              </DropdownMenuItem>
            )}

            {canArchive && (
              <DropdownMenuItem onClick={onArchive} className="md:hidden">
                <Archive className="h-4 w-4" /> {tr("أرشفة")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onSpam} className="md:hidden">
              <AlertOctagon className="h-4 w-4" /> {tr("مزعج")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> {isTrash ? tr("حذف نهائي") : tr("نقل إلى المهملات")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto">
        <div className="mx-4 p-4 sm:mx-6 sm:p-6">
          <h1 className="break-words text-xl font-bold leading-snug sm:text-2xl">
            {message.subject || tr("(بدون موضوع)")}
          </h1>

          <div className="mt-4 flex items-start gap-3 border-b border-border pb-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
              {(message.from.name || message.from.email || "?").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold leading-tight">
                    {message.from.name || message.from.email || tr("(مرسل غير معروف)")}
                  </div>
                  {message.from.name && message.from.email && (
                    <div
                      className="truncate text-xs text-muted-foreground"
                      title={message.from.email}
                    >
                      <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                        {message.from.email}
                      </span>
                    </div>
                  )}
                </div>
                <span
                  className="shrink-0 whitespace-nowrap text-sm text-muted-foreground"
                  title={new Date(message.date).toLocaleString(getCurrentLang())}
                >
                  {formatDate(message.date, getCurrentLang())}
                </span>
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-expanded={detailsOpen}
                  className="inline-flex max-w-full items-center gap-1 rounded hover:text-foreground"
                  title={tr("تفاصيل الرسالة")}
                >
                  <span className="truncate">
                    <span className="text-foreground/70">{tr("إلى")} </span>
                    <span dir="ltr" className="unicode-bidi-isolate">
                      {toSummary}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {detailsOpen && (
                  <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3">
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1.5 text-sm">
                      <dt className="text-foreground/70 whitespace-nowrap">{tr("المرسل:")}</dt>
                      <dd className="min-w-0 break-all">
                        {message.from.name ? (
                          <span className="me-1">{message.from.name}</span>
                        ) : null}
                        <span dir="ltr" className="text-muted-foreground">
                          &lt;{message.from.email || "—"}&gt;
                        </span>
                      </dd>

                      <dt className="text-foreground/70 whitespace-nowrap">{tr("المستلم:")}</dt>
                      <dd className="min-w-0 break-all">
                        <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                          {message.to.length > 0 ? message.to.map((t) => t.email).join(", ") : "—"}
                        </span>
                      </dd>

                      {message.cc && message.cc.length > 0 && (
                        <>
                          <dt className="text-foreground/70 whitespace-nowrap">{tr("نسخة:")}</dt>
                          <dd className="min-w-0 break-all">
                            <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                              {message.cc.map((c) => c.email).join(", ")}
                            </span>
                          </dd>
                        </>
                      )}

                      <dt className="text-foreground/70 whitespace-nowrap">{tr("التاريخ:")}</dt>
                      <dd className="min-w-0">{fullDate}</dd>

                      {message.mailedBy && (
                        <>
                          <dt className="text-foreground/70 whitespace-nowrap">{tr("الخادم:")}</dt>
                          <dd className="min-w-0 break-all">
                            <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                              {message.mailedBy}
                            </span>
                          </dd>
                        </>
                      )}
                      {message.signedBy && (
                        <>
                          <dt className="text-foreground/70 whitespace-nowrap">{tr("التوقيع:")}</dt>
                          <dd className="min-w-0 break-all">
                            <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                              {message.signedBy}
                            </span>
                          </dd>
                        </>
                      )}
                      {message.security && (
                        <>
                          <dt className="text-foreground/70 whitespace-nowrap">{tr("الأمان:")}</dt>
                          <dd className="min-w-0 inline-flex items-center gap-1">
                            {isSecure ? (
                              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                            )}
                            <span>{securityLabel}</span>
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                )}
              </div>
            </div>
          </div>

          {loading ? (
            <MessageBodySkeleton />
          ) : (
            <>
              <MessageBody
                message={message}
                html={message.body || message.preview || ""}
                onInlineImages={handleInlineImages}
                onEntireBody={onEntireBody}
                className="mt-6"
                afterLatest={
                  <>
                    <MessageAttachmentsSection message={message} />
                    <MessageReplyButtons
                      className="mt-6"
                      onReply={onReply}
                      onReplyAll={onReplyAll}
                      onForward={onForward}
                    />
                  </>
                }
                suppressQuoted={hasThreadRows}
              />
              {hasThreadRows && (
                <ConversationHistory
                  rows={threadRows!}
                  onCompose={onComposeFor}
                  onOpenHistorical={onOpenHistorical}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function EmptyViewer() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
      <MailIcon className="h-16 w-16 opacity-30" />
      <p className="text-sm">{tr("اختر رسالة من القائمة لعرضها")}</p>
    </div>
  );
}

function MessageBodySkeleton() {
  return (
    <div className="mt-6 space-y-3" aria-label={tr("جاري تحميل نص الرسالة")}>
      <div className="h-3 w-full animate-pulse rounded bg-muted" />
      <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
      <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  );
}

function LoadingViewer({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
          aria-label={tr("رجوع")}
        >
          <ChevronBackward className="h-4 w-4" /> {tr("رجوع")}
        </button>
        <div />
      </div>
      <div className="mx-4 flex-1 p-4 sm:mx-6 sm:p-6">
        <div className="h-7 w-2/3 animate-pulse rounded bg-muted" />
        <div className="mt-5 h-12 w-full animate-pulse rounded bg-muted/70" />
        <MessageBodySkeleton />
      </div>
    </>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}

type Recipient = { email: string; name?: string; valid: boolean };

function parseRecipientText(raw: string): Recipient[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      // Support "Name <email@x.com>"
      const m = token.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
      const email = (m ? m[2] : token).trim();
      const name = m ? m[1].replace(/^["']|["']$/g, "").trim() || undefined : undefined;
      return { email, name, valid: isValidEmail(email) };
    });
}

function recipientsToRaw(list: Recipient[]): string {
  return list.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plainToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/**
 * Public extension slot for the composer toolbar. Third-party integrations
 * (AI assistants, templates, scheduling, signatures) can register buttons
 * without touching this file:
 *
 *   window.mailmaestroComposerExtensions ??= [];
 *   window.mailmaestroComposerExtensions.push({
 *     id: "ai-assist",
 *     label: "AI",
 *     icon: "✨",
 *     onClick: (ctx) => ctx.insertHtml("<p>...</p>"),
 *   });
 */
export type ComposerExtension = {
  id: string;
  label: string;
  icon?: string;
  title?: string;
  onClick: (ctx: {
    getHtml: () => string;
    setHtml: (html: string) => void;
    insertHtml: (html: string) => void;
    getSubject: () => string;
    setSubject: (s: string) => void;
    getRecipients: () => { to: string[]; cc: string[]; bcc: string[] };
  }) => void;
};

declare global {
  interface Window {
    mailmaestroComposerExtensions?: ComposerExtension[];
  }
}

// ------------ Recipient chip input (To / Cc / Bcc) ------------
function RecipientField({
  label,
  value,
  onChange,
  onFocus,
  autoFocus,
  rightSlot,
  getSuggestions,
  onHideSuggestion,
}: {
  label: string;
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
  onFocus?: () => void;
  autoFocus?: boolean;
  rightSlot?: React.ReactNode;
  /**
   * Purely-local (no-network) address-book lookup for the current mail scope.
   * `exclude` are chip emails already chosen in this field.
   */
  getSuggestions?: (query: string, exclude: string[]) => AutocompleteMatch[];
  /** Fire-and-forget hide (server + local cache). */
  onHideSuggestion?: (email: string) => void;
}) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<AutocompleteMatch[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Recompute local suggestions on every keystroke. All in-memory, zero I/O.
  useEffect(() => {
    if (!getSuggestions) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const q = text.trim();
    if (q.length < 1) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const excl = value.map((r) => r.email);
    const matches = getSuggestions(q, excl);
    setSuggestions(matches);
    setActiveIdx(0);
    setOpen(matches.length > 0);
  }, [text, value, getSuggestions]);

  const commit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const next = parseRecipientText(trimmed);
      if (next.length === 0) return;
      const seen = new Set(value.map((r) => r.email.toLowerCase()));
      const merged = [...value];
      for (const r of next) {
        const k = r.email.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          merged.push(r);
        }
      }
      onChange(merged);
      setText("");
      setOpen(false);
    },
    [value, onChange],
  );

  const acceptSuggestion = useCallback(
    (m: AutocompleteMatch) => {
      const formatted = m.name ? `${m.name} <${m.email}>` : m.email;
      commit(formatted);
    },
    [commit],
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      <div className="relative w-full min-w-0">
        <div
          className="flex min-h-[42px] w-full min-w-0 flex-wrap items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20"
          onClick={() => inputRef.current?.focus()}
        >
          <div
            className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-1.5 sm:basis-auto"
            dir="ltr"
          >
            {value.map((r, i) => (
              <span
                key={`${r.email}-${i}`}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                  r.valid
                    ? "bg-muted text-foreground"
                    : "bg-red-500/10 text-red-600 dark:text-red-400"
                }`}
                title={r.valid ? r.email : tr("بريد غير صالح")}
              >
                {!r.valid && <AlertTriangle className="h-3 w-3" />}
                <span className="max-w-[220px] truncate">
                  {r.name ? `${r.name} · ${r.email}` : r.email}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(value.filter((_, idx) => idx !== i));
                  }}
                  className="rounded-full p-0.5 hover:bg-background/60"
                  aria-label={trf("إزالة {{email}}", { email: r.email })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => {
                const v = e.target.value;
                if (/[,;]/.test(v)) {
                  commit(v);
                  return;
                }
                setText(v);
              }}
              onFocus={onFocus}
              onKeyDown={(e) => {
                if (open && suggestions.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIdx((i) => (i + 1) % suggestions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setOpen(false);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptSuggestion(suggestions[activeIdx]);
                    return;
                  }
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  if (text.trim()) {
                    e.preventDefault();
                    commit(text);
                  }
                } else if (e.key === "Backspace" && text === "" && value.length > 0) {
                  onChange(value.slice(0, -1));
                }
              }}
              onBlur={() => {
                // Delay so a click on a suggestion still registers.
                setTimeout(() => setOpen(false), 120);
                commit(text);
              }}
              onPaste={(e) => {
                const p = e.clipboardData.getData("text");
                if (/[,;\n<>]/.test(p) || p.split(/\s+/).length > 1) {
                  e.preventDefault();
                  commit(p);
                }
              }}
              placeholder=""
              className="min-w-[80px] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
              aria-autocomplete="list"
              aria-expanded={open}
            />
          </div>
          {rightSlot}
        </div>
        {open && suggestions.length > 0 && (
          <ul
            className="absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
            role="listbox"
            dir="ltr"
          >
            {suggestions.map((m, i) => (
              <li
                key={m.email}
                role="option"
                aria-selected={i === activeIdx}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus
                  acceptSuggestion(m);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={`flex items-center justify-between gap-2 px-3 py-1.5 ${
                  i === activeIdx ? "bg-accent" : "hover:bg-accent/60"
                }`}
              >
                <div className="min-w-0 flex-1">
                  {m.name ? (
                    <>
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                    </>
                  ) : (
                    <div className="truncate">{m.email}</div>
                  )}
                </div>
                {onHideSuggestion && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onHideSuggestion(m.email);
                      setSuggestions((prev) => prev.filter((s) => s.email !== m.email));
                    }}
                    className="rounded p-1 text-muted-foreground opacity-60 hover:bg-background hover:opacity-100"
                    title={tr("إزالة من الاقتراحات")}
                    aria-label={tr("إزالة من الاقتراحات")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------ Rich-text editor toolbar ------------
function ToolbarButton({
  onMouseDown,
  title,
  children,
  active,
}: {
  onMouseDown: () => void;
  title: string;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => {
        e.preventDefault(); // keep selection in editor
        onMouseDown();
      }}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground ${
        active ? "bg-muted text-foreground" : ""
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarSelect({
  title,
  ariaLabel,
  placeholder,
  value,
  options,
  onChange,
  className,
}: {
  title: string;
  ariaLabel: string;
  placeholder: string;
  value?: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`relative inline-flex h-7 items-center ${className ?? ""}`}>
      <select
        title={title}
        aria-label={ariaLabel}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v) onChange(v);
        }}
        className="peer h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-background ps-2 pe-7 text-xs text-foreground outline-none hover:bg-muted focus:ring-2 focus:ring-ring/40"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute end-2.5 h-3 w-3 text-muted-foreground" />
    </div>
  );
}

type SendProgressStage =
  | "preparing"
  | "saving"
  | "uploading"
  | "delivering"
  | "confirming"
  | "complete";

interface SendProgressState {
  progress: number;
  stage: SendProgressStage;
}

function SendProgressPanel({ state }: { state: SendProgressState }) {
  const isArabic = getCurrentLang() === "ar";
  const rounded = Math.min(100, Math.max(0, Math.round(state.progress)));
  const formatted = new Intl.NumberFormat(isArabic ? "ar-SA" : "en-US").format(rounded);
  const complete = state.stage === "complete" && rounded >= 100;
  const stageLabel = {
    preparing: tr("جاري تجهيز الرسالة للإرسال"),
    saving: tr("جاري حفظ محتويات الرسالة بأمان"),
    uploading: tr("جاري رفع الملفات بأمان"),
    delivering: tr("جاري تسليم الرسالة إلى خادم البريد"),
    confirming: tr("جاري تأكيد التسليم من خادم البريد"),
    complete: tr("اكتمل الإرسال بنجاح"),
  } satisfies Record<SendProgressStage, string>;
  return (
    <aside
      role="status"
      aria-live="polite"
      dir={isArabic ? "rtl" : "ltr"}
      className={cn(
        "fixed bottom-4 z-[100] w-[min(20rem,calc(100vw-2rem))] animate-in rounded-[1.35rem] border border-primary/10 bg-background/90 p-3.5 shadow-[0_18px_50px_-20px_hsl(var(--foreground)/0.28)] backdrop-blur-xl duration-300",
        isArabic ? "left-4 slide-in-from-left-4" : "right-4 slide-in-from-right-4",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-300",
            complete ? "bg-emerald-500/12 text-emerald-600" : "bg-primary/10 text-primary",
          )}
        >
          {complete ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {!complete && (
            <span className="absolute -end-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-background bg-primary" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">
              {tr(complete ? "تم إرسال الرسالة" : "جاري إرسال الرسالة")}
            </p>
            <span className="text-xs font-semibold tabular-nums text-primary" dir="ltr">
              {formatted}%
            </span>
          </div>
          <p
            className={cn(
              "mt-0.5 text-[11px]",
              complete ? "text-emerald-600" : "text-muted-foreground",
            )}
          >
            {stageLabel[state.stage]}
          </p>
        </div>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted/80"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
      >
        <div
          className="relative h-full transition-[width] duration-300 ease-out"
          style={{ width: `${rounded}%` }}
        >
          <div
            className={cn(
              "absolute inset-0 rounded-full transition-colors duration-300",
              complete ? "bg-emerald-500" : "bg-brand-gradient",
            )}
          />
          {rounded < 100 && (
            <div className="absolute inset-y-0 end-0 w-8 animate-pulse rounded-full bg-white/40" />
          )}
        </div>
      </div>
    </aside>
  );
}

function Composer({
  session,
  initial,
  onClose,
  onSent,
  onDraftCreated,
  onDraftSaved,
  onDraftDeleteStart,
  onDraftDeleteRollback,
  onDraftDeleted,
}: {
  session: MailSession;
  initial?: ComposeInitial | null;
  onClose: (options: { refreshDrafts: boolean }) => void;
  onSent: (info: PostSendInfo) => void;
  onDraftCreated: () => void;
  onDraftSaved: (
    identity: SavedDraftIdentity,
    previousRef?: { folderPath: string; uid: number; uidValidity: string } | null,
  ) => void;
  onDraftDeleteStart: (draftId: string, options?: { activateDraftCountGuard?: boolean }) => void;
  onDraftDeleteRollback: (draftId: string) => void;
  onDraftDeleted: (draftId: string) => void;
}) {
  // Draft storage keying is owned by mail-draft-lifecycle (v3 + auto-migration).
  const { confirm } = useConfirm();

  // ----- Address book (contact suggestions) — local IDB, hydrated once -----
  const hydrateSuggestions = useMailServerFn(hydrateContactSuggestions);
  const recordSuggestions = useMailServerFn(recordSentRecipients);
  const hideSuggestion = useMailServerFn(hideContactSuggestion);
  const companyId = session.account.company_id;
  const accountId = session.account.id;
  const lastScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const scopeKey = `${companyId}:${accountId}`;
    if (lastScopeRef.current && lastScopeRef.current !== scopeKey) {
      // Account switched inside the same tab — drop the previous scope's mem cache.
      clearMemoryCache();
    }
    lastScopeRef.current = scopeKey;
    const token = session.mailSessionToken;
    void ensureScopeReady(companyId, accountId, async () => {
      if (!token) return null;
      try {
        const res = await hydrateSuggestions({ data: { mailSessionToken: token } });
        return res?.ok ? res.suggestions : null;
      } catch {
        return null;
      }
    });
  }, [companyId, accountId, session.mailSessionToken, hydrateSuggestions]);

  const suggestFor = useCallback(
    (query: string, exclude: string[]) =>
      searchLocal(companyId, accountId, query, { exclude, limit: 8 }),
    [companyId, accountId],
  );
  const hideOne = useCallback(
    (email: string) => {
      void forgetLocal(companyId, accountId, email);
      const token = session.mailSessionToken;
      if (!token) return;
      void hideSuggestion({ data: { mailSessionToken: token, email } }).catch(() => {
        /* fire-and-forget */
      });
    },
    [companyId, accountId, session.mailSessionToken, hideSuggestion],
  );

  // ----- Restore draft (v3 with v2 auto-migration) -----
  const accountEmail = session.account.email_address;
  const isEditMode = Boolean(initial?.editDraftId);
  const initialDoc = useMemo<DraftDocV3 | null>(() => {
    if (typeof window === "undefined") return null;
    if (isEditMode && initial?.editDraftId) {
      const sameDraft = readDraftDocById(window.localStorage, accountEmail, initial.editDraftId);
      if (!sameDraft) return null;
      const local = sameDraft.localRevision ?? 1;
      const remote = sameDraft.remoteCommittedRevision ?? 0;
      return sameDraft.remoteCommitConfirmed === true && local === remote ? null : sameDraft;
    }
    if (initial && (initial.to || initial.cc || initial.subject || initial.body)) return null;
    return readDraftDoc(window.localStorage, accountEmail);
  }, [initial, accountEmail, isEditMode]);
  const restored = initialDoc?.snapshot ?? null;
  const [threadingHeaders] = useState(() =>
    buildThreadingHeaders(
      restored?.references ?? initial?.references,
      restored?.inReplyTo ?? initial?.inReplyTo,
    ),
  );
  const autosaveRefreshTrackerRef = useRef<ReturnType<
    typeof createDraftAutosaveRefreshTracker
  > | null>(null);
  if (!autosaveRefreshTrackerRef.current) {
    autosaveRefreshTrackerRef.current = createDraftAutosaveRefreshTracker(
      isEditMode || Boolean(initial?.previousRef) || Boolean(initialDoc?.serverRef),
    );
  }

  const [draftId] = useState<string>(
    () => initial?.editDraftId ?? initialDoc?.draftId ?? newDraftId(),
  );
  const [serverRef, setServerRef] = useState<DraftServerRef | null>(
    () => initial?.previousRef ?? initialDoc?.serverRef ?? null,
  );
  const [saveStatus, setSaveStatus] = useState<DraftSaveStatus>(() =>
    initialDoc?.remoteCommitConfirmed ? "saved" : isEditMode ? "saved" : "idle",
  );
  const [hasLocalDraft, setHasLocalDraft] = useState(() => Boolean(initialDoc));
  const [hasRemoteDraft, setHasRemoteDraft] = useState(
    () => isEditMode || Boolean(initial?.previousRef) || Boolean(initialDoc?.serverRef),
  );
  const [deletingDraft, setDeletingDraft] = useState(false);
  // DELETE INTENT fence: once set, no NEW autosave may start and no duplicate
  // Delete may begin. It is cleared only on confirm-cancel or delete failure.
  const deleteIntentRef = useRef(false);
  const closeIntentAfterUploadRef = useRef<number | null>(null);
  const serverRefRef = useRef<DraftServerRef | null>(serverRef);
  useEffect(() => {
    serverRefRef.current = serverRef;
  }, [serverRef]);

  const [to, setTo] = useState<Recipient[]>(
    () => restored?.to ?? parseRecipientText(initial?.to ?? ""),
  );
  const [cc, setCc] = useState<Recipient[]>(
    () => restored?.cc ?? parseRecipientText(initial?.cc ?? ""),
  );
  const [bcc, setBcc] = useState<Recipient[]>(
    () => restored?.bcc ?? parseRecipientText(initial?.bcc ?? ""),
  );
  const [showCc, setShowCc] = useState<boolean>(
    () => restored?.showCc ?? initial?.showCc ?? parseRecipientText(initial?.cc ?? "").length > 0,
  );
  const [showBcc, setShowBcc] = useState<boolean>(
    () =>
      restored?.showBcc ?? initial?.showBcc ?? parseRecipientText(initial?.bcc ?? "").length > 0,
  );
  const [subject, setSubject] = useState<string>(() => restored?.subject ?? initial?.subject ?? "");
  const initialHtml = useMemo(() => {
    if (restored?.html) return restored.html;
    if (initial?.bodyIsHtml && initial.body) return initial.body;
    if (initial?.body) return plainToHtml(initial.body);
    return "";
  }, [restored, initial]);

  // Existing Draft/Forward server attachments stay metadata-only in
  // the browser. Save/send uses a durable staged handle or the IMAP source
  // identity; attachment bytes remain entirely on the Bridge data plane.
  const restoredStaged = (restored?.stagedAttachments ?? []).filter(
    (item) => item.expiresAt == null || item.expiresAt > Date.now() + 5_000,
  );
  const restoredSource = restored?.sourceAttachments;
  const restoredHandleByAttachmentIdRef = useRef(
    new Map(restoredStaged.map((item, index) => [`staged:${index}`, item.handle])),
  );
  const [existingKept, setExistingKept] = useState<import("@/lib/mail-types").MailAttachment[]>(
    () => [
      ...(initial?.existingAttachments?.attachments ?? []),
      ...(restoredSource?.attachments ?? []),
      ...restoredStaged.map((item, index) => ({
        id: `staged:${index}`,
        filename: item.filename,
        size: item.size,
        mimeType: item.mimeType,
      })),
    ],
  );
  const [files, setFiles] = useState<File[]>([]);
  const [inlineImages, setInlineImages] = useState<InlineComposeImage[]>([]);
  const [signatureImagesLoading, setSignatureImagesLoading] = useState(0);
  const [uploadState, setUploadState] = useState<
    Map<File, { status: "uploading" | "ready" | "failed"; progress: number }>
  >(new Map());
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState<SendProgressState>({
    progress: 0,
    stage: "preparing",
  });
  // Composer runs inline inside the message-viewer pane (Superhuman-style).
  const [dragging, setDragging] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(() => initialDoc?.updatedAt ?? null);

  // ----- Dirty tracking + guarded close -----
  // Generation-based dirty: `generation` bumps on every user edit (body input
  // or structural field change). `savedGeneration` only advances when the
  // saver reports a completion for THAT generation via `onCompleted`. A
  // stale response never marks newer content clean.
  const draftEngineRef = useRef<DraftEngine | null>(null);
  if (!draftEngineRef.current) {
    const engine = new DraftEngine();
    if (initialDoc) {
      engine.restoreGenerations(
        initialDoc.localRevision ?? 1,
        initialDoc.remoteCommittedRevision ?? 0,
      );
    }
    draftEngineRef.current = engine;
  }
  const generationRef = useRef<number>(draftEngineRef.current.userGeneration);
  const savedGenerationRef = useRef<number>(draftEngineRef.current.savedGeneration);
  const isDirtyRef = useRef<boolean>(draftEngineRef.current.isDirty);
  const currentRevisionIdRef = useRef<string>(initialDoc?.revisionId ?? newDraftId());
  // Kept for the header "saved just now" UI only — not the dirty source of truth.
  const lastSavedAtRef = useRef<number>(initialDoc?.updatedAt ?? 0);

  // Diagnostic: last hard-failure code from the saver (null on success).
  const lastFailCodeRef = useRef<string | null>(null);
  // Attachment-set signature recorded after an authoritative attachment-size
  // failure. While the signature is unchanged, automatic remote draft-saves
  // are skipped so a size-blocked Forward stops re-downloading its IMAP
  // attachments on every autosave tick. Cleared when the set changes or a
  // remote save succeeds. Manual Save/Send never consult this ref.
  const sizeBlockedAttachmentSignatureRef = useRef<string | null>(null);
  // request generation -> attachment signature of the transport THAT request
  // actually built (captured inside saveRemote, consumed on completion). A
  // late failure for an older request is attributed to its own signature,
  // never to the live composer refs at completion time.
  const requestSignatureByGenerationRef = useRef<RequestBoundSignatureStore | null>(null);
  if (requestSignatureByGenerationRef.current === null) {
    requestSignatureByGenerationRef.current = createRequestBoundSignatureStore();
  }
  const lastDiagnosticAttachmentSignatureRef = useRef<string | null>(null);
  const remoteSaveStartedAtByGenerationRef = useRef<Map<number, number>>(new Map());

  const syncDraftEngineRefs = () => {
    const engine = draftEngineRef.current;
    if (!engine) return;
    generationRef.current = engine.userGeneration;
    savedGenerationRef.current = engine.savedGeneration;
    isDirtyRef.current = engine.isDirty;
  };
  const recomputeDirty = () => {
    syncDraftEngineRefs();
  };
  const markEdited = () => {
    draftEngineRef.current?.markUserEdit();
    currentRevisionIdRef.current = newDraftId();
    closeIntentAfterUploadRef.current = null;
    recomputeDirty();
  };
  const suppressNextServerHydrationDirtyRef = useRef(false);
  // bodyRev mirrors generation for the autosave effect dependency (React
  // needs a value in deps; contentEditable does not trigger re-renders).
  const [bodyRev, setBodyRev] = useState(0);
  const [closePrompt, setClosePrompt] = useState<{
    resolve: (choice: "save" | "discard" | "cancel") => void;
  } | null>(null);

  // ----- Server-side draft saver (bridge APPEND) + pending-delete queue -----
  const bridgeDeleteDraftFn = useMailServerFn(bridgeDeleteDraft);

  const pendingQueueRef = useRef<PendingDeleteQueue | null>(null);
  if (!pendingQueueRef.current && typeof window !== "undefined") {
    pendingQueueRef.current = createPendingDeleteQueue({
      storage: window.localStorage,
      deleteRemote: async ({ draftId: d, previousRef }) => {
        const token = session.mailSessionToken;
        if (!token) return { ok: false, code: "SESSION_REQUIRED" };
        try {
          const res = await bridgeDeleteDraftFn({
            data: {
              mailSessionToken: token,
              draftId: d,
              previousRef: previousRef ?? undefined,
            },
          });
          return { ok: !!res?.ok, code: res && !res.ok ? res.code : undefined };
        } catch {
          return { ok: false, code: "NETWORK" };
        }
      },
    });
  }

  // Flush any deletes left behind by a previous send in this browser.
  useEffect(() => {
    const q = pendingQueueRef.current;
    if (!q) return;
    void q.flush(accountEmail);
  }, [accountEmail]);

  // Forward refs so the persistent saveRemote closure (created once at mount)
  // always reads the latest attachment state without a re-instantiation.
  const filesRef = useRef<File[]>([]);
  const inlineImagesRef = useRef<InlineComposeImage[]>([]);
  // Server Working Draft revision is the cross-session authority. The local
  // DraftEngine still governs rendering, dirty state, and close fencing.
  const workingRevisionRef = useRef(0);
  const workingAttachmentByFileRef = useRef<WeakMap<File, WorkingDraftAttachmentReference>>(
    new WeakMap(),
  );
  const workingAttachmentUploadRef = useRef<
    WeakMap<File, Promise<WorkingDraftAttachmentReference>>
  >(new WeakMap());
  const workingAttachmentClientKeyRef = useRef<WeakMap<File, string>>(new WeakMap());
  const workingAttachmentByExistingIdRef = useRef<Map<string, WorkingDraftAttachmentReference>>(
    new Map(),
  );
  const workingAttachmentByInlineIdRef = useRef<Map<string, WorkingDraftAttachmentReference>>(
    new Map(),
  );
  const workingDraftRecordRef = useRef<WorkingDraftRecord | null>(null);
  const workingDraftLoadPromiseRef = useRef<Promise<WorkingDraftRecord | null> | null>(null);
  const currentMailSessionTokenRef = useRef<string>(session.mailSessionToken ?? "");
  currentMailSessionTokenRef.current = session.mailSessionToken ?? "";
  const hydratedInlineImageIdsRef = useRef<Set<string>>(new Set());
  const fileDependencyByFileRef = useRef<Map<File, { key: string }>>(new Map());
  const unresolvedInlineDependenciesRef = useRef<Map<string, string>>(new Map());
  const abandonedUploadsRef = useRef<Set<File>>(new Set());
  const [transportCache] = useState(() =>
    typeof window === "undefined"
      ? null
      : readDraftTransportCache(window.localStorage, accountEmail, draftId),
  );
  const stagedUploadsRef = useRef<StagedUploadCache>(new WeakMap());
  const stagedReadyRef = useRef<StagedReadyCache>(new WeakMap());
  const restoredInlineHandlesRef = useRef(
    new Map(
      (restored?.inlineImages ?? [])
        .filter(
          (image) =>
            image.stagedHandle &&
            (image.stagedExpiresAt == null || image.stagedExpiresAt > Date.now() + 5_000),
        )
        .map((image) => [image.uploadFilename, image.stagedHandle!]),
    ),
  );
  const transportInlineHandleByCidRef = useRef(
    new Map((transportCache?.inline ?? []).map((entry) => [entry.resourceId, entry.handle])),
  );
  const preservedSourceHandlesRef = useRef<Map<string, string>>(
    new Map(
      (initial?.existingAttachments?.attachments ?? []).flatMap((attachment) => {
        const metadataKey = `${attachment.filename}\u0000${attachment.size}\u0000${attachment.mimeType}`;
        const cached = (transportCache?.normal ?? []).find(
          (entry) => entry.resourceId === attachment.id || entry.resourceId === metadataKey,
        );
        return cached ? [[attachment.id, cached.handle] as const] : [];
      }),
    ),
  );
  const attachmentSourceRef = useRef(
    initial?.attachmentSourceRef ?? restoredSource?.sourceRef ?? null,
  );
  const autosaveRef = useRef<ReturnType<typeof createAutosaveScheduler> | null>(null);

  // Prefer an existing server Working Draft when the Composer is opened on a
  // second device/tab. This is metadata-only: attachment cards are rebuilt
  // from durable references and no provider attachment bytes are fetched.
  useEffect(() => {
    let cancelled = false;
    const token = currentMailSessionTokenRef.current;
    if (!token) return;
    const load = (async (): Promise<WorkingDraftRecord | null> => {
      try {
        const response = await fetch("/api/mail-working-draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mailSessionToken: token, action: "load", draftId }),
        });
        const result = (await response.json().catch(() => null)) as {
          ok?: boolean;
          record?: WorkingDraftRecord | null;
        } | null;
        const record = result?.ok ? result.record : null;
        if (!record || !Number.isSafeInteger(record.revision)) return null;
        workingDraftRecordRef.current = record;
        workingRevisionRef.current = record.revision;
        if (cancelled || isDirtyRef.current) return record;
        const snapshot = record.payload.snapshot;
        // One-shot hydration guard: applying server-owned fields below must
        // not be interpreted by the structural dirty-marking effect as a user
        // edit. The effect consumes this flag on the next render.
        suppressNextServerHydrationDirtyRef.current = true;
        setTo(snapshot.to ?? []);
        setCc(snapshot.cc ?? []);
        setBcc(snapshot.bcc ?? []);
        setSubject(snapshot.subject ?? "");
        setShowCc(Boolean(snapshot.showCc));
        setShowBcc(Boolean(snapshot.showBcc));
        if (editorRef.current) {
          editorRef.current.innerHTML = snapshot.html ?? "";
          hydrateComposerDirection(editorRef.current, snapshot.dir);
        }
        const normal = record.payload.attachments.filter(
          (attachment) => attachment.kind === "attachment",
        );
        const cards = normal.map((attachment) => ({
          id: attachment.clientKey,
          filename: attachment.filename,
          size: attachment.size,
          mimeType: attachment.mimeType,
          disposition: attachment.disposition,
        }));
        for (const attachment of normal) {
          workingAttachmentByExistingIdRef.current.set(attachment.clientKey, attachment);
        }
        setExistingKept(cards);
        if (record.checkpoint?.serverRef) {
          serverRefRef.current = record.checkpoint.serverRef;
          setServerRef(record.checkpoint.serverRef);
        }
        setHasRemoteDraft(true);
        setSavedAt(Date.now());
        draftEngineRef.current?.markSaved(generationRef.current);
        syncDraftEngineRefs();
        return record;
      } catch {
        // Local crash recovery remains usable when the Working Draft service
        // is temporarily unavailable.
        return null;
      }
    })();
    workingDraftLoadPromiseRef.current = load;
    void load;
    return () => {
      cancelled = true;
    };
    // Composer is keyed by draft identity; a new token only affects future saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const saverRef = useRef<DraftSaver | null>(null);

  const currentDiagnosticAttachmentSignature = () =>
    attachmentSetSignature({
      existingKept: existingKeptRef.current,
      files: filesRef.current,
      inlineImages: inlineImagesRef.current,
    });

  const makeDraftSaveTriggerDiagnostics = (
    reason: DraftSaveTriggerReason,
    generation: number,
  ): DraftSaveTriggerDiagnostics => {
    const currentSignature = currentDiagnosticAttachmentSignature();
    const inFlight = saverRef.current?.isBusy() ?? false;
    return {
      reason,
      generation,
      inFlight,
      coalesced: inFlight,
      dirty: isDirtyRef.current,
      attachmentsChanged:
        lastDiagnosticAttachmentSignatureRef.current !== null &&
        lastDiagnosticAttachmentSignatureRef.current !== currentSignature,
    };
  };

  // Stable, always-current token ref so the release helpers (including the
  // one-shot editor input listener) never capture a stale session token.
  const mailSessionTokenRef = useRef<string>(session.mailSessionToken ?? "");
  mailSessionTokenRef.current = session.mailSessionToken ?? "";

  async function deleteServerWorkingDraft(
    previousRef: { folderPath: string; uid: number; uidValidity: string } | null = null,
  ): Promise<{ ok: boolean; code?: string }> {
    const token = mailSessionTokenRef.current;
    if (!token) return { ok: false, code: "SESSION_REQUIRED" };
    try {
      const response = await fetch("/api/mail-working-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailSessionToken: token,
          action: "delete",
          draftId,
          previousRef: previousRef ?? undefined,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        code?: string;
      } | null;
      if (response.ok && result?.ok === true) return { ok: true };
      return { ok: false, code: result?.code ?? "UNKNOWN" };
    } catch {
      return { ok: false, code: "NETWORK" };
    }
  }

  async function discardServerWorkingDraft(
    refs: {
      serverRef?: { folderPath: string; uid: number; uidValidity: string } | null;
      previousRef?: { folderPath: string; uid: number; uidValidity: string } | null;
    } = {},
  ): Promise<{ ok: boolean; code?: string }> {
    const token = mailSessionTokenRef.current;
    if (!token) return { ok: false, code: "SESSION_REQUIRED" };
    try {
      const response = await fetch("/api/mail-working-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailSessionToken: token,
          action: "discard",
          draftId,
          serverRef: refs.serverRef ?? undefined,
          previousRef: refs.previousRef ?? undefined,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        code?: string;
      } | null;
      if (response.ok && result?.ok === true) return { ok: true };
      return { ok: false, code: result?.code ?? "UNKNOWN" };
    } catch {
      return { ok: false, code: "NETWORK" };
    }
  }

  // ----- Explicit staged-handle release (best-effort, never blocks the UI) -----
  // Handles are released only when genuinely abandoned: an attachment or inline
  // image removed, a draft deleted, or the composer discarded. A failed release
  // is harmless — unreachable staged files expire naturally by TTL.
  function releaseStagedHandle(handle: string | undefined | null, onReleased?: () => void) {
    if (!handle) return;
    const token = mailSessionTokenRef.current;
    if (!token) return;
    void releaseStagedHandles(token, [handle])
      .then((released) => {
        if (released) onReleased?.();
      })
      .catch(() => undefined);
  }

  function collectOwnedStagedHandles(): string[] {
    const handles: string[] = [];
    for (const handle of restoredHandleByAttachmentIdRef.current.values()) handles.push(handle);
    for (const handle of preservedSourceHandlesRef.current.values()) handles.push(handle);
    for (const handle of restoredInlineHandlesRef.current.values()) handles.push(handle);
    for (const file of filesRef.current) {
      const ready = getStagedReady(stagedReadyRef.current, file, "attachment", file.name);
      if (ready?.handle) handles.push(ready.handle);
    }
    for (const image of inlineImagesRef.current) {
      const ready = getStagedReady(
        stagedReadyRef.current,
        image.file,
        "inline-image",
        image.uploadFilename,
      );
      const handle =
        image.stagedHandle ??
        restoredInlineHandlesRef.current.get(image.uploadFilename) ??
        ready?.handle;
      if (handle) handles.push(handle);
    }
    return handles;
  }

  function persistOwnedTransportCache() {
    if (typeof window === "undefined") return;
    const normal = [
      ...existingKeptRef.current.flatMap((attachment) => {
        const handle =
          restoredHandleByAttachmentIdRef.current.get(attachment.id) ??
          preservedSourceHandlesRef.current.get(attachment.id);
        if (!handle) return [];
        return [
          {
            resourceId: `${attachment.filename}\u0000${attachment.size}\u0000${attachment.mimeType}`,
            handle,
          },
        ];
      }),
      ...filesRef.current.flatMap((file) => {
        const staged = getStagedReady(stagedReadyRef.current, file, "attachment", file.name);
        return staged
          ? [
              {
                resourceId: `${file.name}\u0000${file.size}\u0000${file.type}`,
                handle: staged.handle,
                expiresAt: staged.expiresAt,
              },
            ]
          : [];
      }),
    ];
    const inline = inlineImagesRef.current.flatMap((image) => {
      const staged = getStagedReady(
        stagedReadyRef.current,
        image.file,
        "inline-image",
        image.uploadFilename,
      );
      const handle =
        image.stagedHandle ??
        restoredInlineHandlesRef.current.get(image.uploadFilename) ??
        staged?.handle;
      return handle
        ? [{ resourceId: image.cid.toLowerCase(), handle, expiresAt: staged?.expiresAt }]
        : [];
    });
    writeDraftTransportCache(window.localStorage, accountEmail, draftId, { normal, inline });
  }

  function clearOwnedStagedHandles() {
    restoredHandleByAttachmentIdRef.current.clear();
    preservedSourceHandlesRef.current.clear();
    restoredInlineHandlesRef.current.clear();
    stagedReadyRef.current = new WeakMap();
    stagedUploadsRef.current = new WeakMap();
    transportInlineHandleByCidRef.current.clear();
  }

  function releaseAllOwnedStagedHandles() {
    const handles = collectOwnedStagedHandles();
    if (handles.length === 0) return;
    const token = mailSessionTokenRef.current;
    if (!token) return;
    void releaseStagedHandles(token, handles)
      .then((released) => {
        if (released) clearOwnedStagedHandles();
      })
      .catch(() => undefined);
  }

  function ensureStaged(file: File, kind: StagedAttachmentKind, filename = file.name) {
    return getOrCreateStagedUpload(stagedUploadsRef.current, file, kind, filename, () => {
      const restoredHandle =
        kind === "inline-image" ? restoredInlineHandlesRef.current.get(filename) : undefined;
      if (restoredHandle) {
        const ready = Promise.resolve({
          handle: restoredHandle,
          filename,
          size: file.size,
          mimeType: file.type,
          kind,
          expiresAt: Number.MAX_SAFE_INTEGER,
        });
        ready.then((result) => {
          const current = stagedUploadsRef.current.get(file)?.get(kind);
          if (current?.filename === filename)
            setStagedReady(stagedReadyRef.current, file, kind, result);
        });
        return ready;
      }
      setUploadState((current) => new Map(current).set(file, { status: "uploading", progress: 0 }));
      return uploadAttachmentDirect(file, {
        mailSessionToken: session.mailSessionToken ?? "",
        kind,
        filename,
        onProgress: (progressValue) => {
          setUploadState((current) =>
            new Map(current).set(file, { status: "uploading", progress: progressValue }),
          );
        },
      })
        .then((result) => {
          if (
            shouldReleaseAbandonedStagedResult({
              resourceAbandoned: abandonedUploadsRef.current.has(file),
              lifecycleFinalizing: deleteIntentRef.current,
            })
          ) {
            releaseStagedHandle(result.handle);
            stagedUploadsRef.current.get(file)?.delete(kind);
            throw new Error("UPLOAD_ABANDONED");
          }
          const current = stagedUploadsRef.current.get(file)?.get(kind);
          if (current?.filename === filename)
            setStagedReady(stagedReadyRef.current, file, kind, result);
          setUploadState((current) =>
            new Map(current).set(file, { status: "ready", progress: 100 }),
          );
          const dep = fileDependencyByFileRef.current.get(file);
          if (dep) {
            draftEngineRef.current?.resolveResourceDependency(dep.key);
            syncDraftEngineRefs();
          }
          if (draftEngineRef.current?.canCommitLatest()) {
            autosaveScheduleReasonRef.current = "attachment-ready";
            autosaveRef.current?.schedule();
          }
          if (
            closeIntentAfterUploadRef.current !== null &&
            draftEngineRef.current?.canCommitLatest()
          ) {
            const closeGeneration = closeIntentAfterUploadRef.current;
            closeIntentAfterUploadRef.current = null;
            void (async () => {
              const result = await saveDraftNow("close");
              if (
                shouldCloseAfterUploadWait({
                  expectedGeneration: closeGeneration,
                  currentGeneration: generationRef.current,
                  saveSucceeded: result === "saved_server",
                })
              ) {
                finalizeCleanClose({ confirmedSavedServer: true });
                closeComposer();
              }
            })();
          }
          return result;
        })
        .catch((error) => {
          const dep = fileDependencyByFileRef.current.get(file);
          if (dep && !abandonedUploadsRef.current.has(file) && !deleteIntentRef.current) {
            draftEngineRef.current?.failResourceDependency(dep.key);
            syncDraftEngineRefs();
          }
          setUploadState((current) =>
            new Map(current).set(file, { status: "failed", progress: 0 }),
          );
          throw error;
        });
    });
  }

  /** Upload a genuinely new Draft resource once to private Working Draft storage. */
  function ensureWorkingAttachment(
    file: File,
    kind: "attachment" | "inline-image",
    options: { filename: string; mimeType: string; cid?: string; disposition?: string },
  ): Promise<WorkingDraftAttachmentReference> {
    const existing = workingAttachmentUploadRef.current.get(file);
    if (existing) return existing;
    let clientKey = workingAttachmentClientKeyRef.current.get(file);
    if (!clientKey) {
      clientKey = crypto.randomUUID();
      workingAttachmentClientKeyRef.current.set(file, clientKey);
    }
    setUploadState((current) => new Map(current).set(file, { status: "uploading", progress: 0 }));
    const promise = (async () => {
      const form = new FormData();
      form.set("mailSessionToken", session.mailSessionToken ?? "");
      form.set("draftId", draftId);
      form.set("clientKey", clientKey);
      form.set("kind", kind);
      form.set("filename", options.filename);
      form.set("mimeType", options.mimeType || "application/octet-stream");
      if (options.cid) form.set("cid", options.cid);
      if (options.disposition) form.set("disposition", options.disposition);
      form.set("file", file, options.filename);
      const response = await fetch("/api/mail-working-draft-attachment", {
        method: "POST",
        body: form,
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        attachment?: WorkingDraftAttachmentReference;
        error?: string;
      } | null;
      if (!response.ok || !result?.ok || !result.attachment) {
        throw new Error(result?.error || "ATTACHMENT_UPLOAD_FAILED");
      }
      const reference = result.attachment;
      workingAttachmentByFileRef.current.set(file, reference);
      setUploadState((current) => new Map(current).set(file, { status: "ready", progress: 100 }));
      const dependency = fileDependencyByFileRef.current.get(file);
      if (dependency) {
        draftEngineRef.current?.resolveResourceDependency(dependency.key);
        syncDraftEngineRefs();
      }
      if (draftEngineRef.current?.canCommitLatest()) {
        autosaveScheduleReasonRef.current = "attachment-ready";
        autosaveRef.current?.schedule();
      }
      return reference;
    })().catch((error) => {
      const dependency = fileDependencyByFileRef.current.get(file);
      if (dependency && !abandonedUploadsRef.current.has(file) && !deleteIntentRef.current) {
        draftEngineRef.current?.failResourceDependency(dependency.key);
        syncDraftEngineRefs();
      }
      setUploadState((current) => new Map(current).set(file, { status: "failed", progress: 0 }));
      workingAttachmentUploadRef.current.delete(file);
      throw error;
    });
    workingAttachmentUploadRef.current.set(file, promise);
    return promise;
  }

  function buildWorkingDraftPayload(snapshot: DraftSnapshot): WorkingDraftPayload {
    const normal = existingKeptRef.current.map((attachment) => {
      const retained = workingAttachmentByExistingIdRef.current.get(attachment.id);
      if (retained) {
        return {
          ...retained,
          filename: attachment.filename,
          mimeType: attachment.mimeType || retained.mimeType,
          size: attachment.size,
          disposition: attachment.disposition ?? retained.disposition,
        };
      }
      const source = attachmentSourceRef.current;
      if (!source || !attachment.part) throw new Error("SOURCE_ATTACHMENT_UNRESOLVED");
      const reference: WorkingDraftAttachmentReference = {
        clientKey: `provider-normal:${source.folderPath}:${source.uidValidity}:${source.uid}:${attachment.part}`,
        kind: "attachment",
        filename: attachment.filename,
        mimeType: attachment.mimeType || "application/octet-stream",
        size: attachment.size,
        disposition: attachment.disposition,
        source: { ...source, part: attachment.part },
      };
      workingAttachmentByExistingIdRef.current.set(attachment.id, reference);
      return reference;
    });
    const added = filesRef.current.map((file) => {
      const reference = workingAttachmentByFileRef.current.get(file);
      if (!reference) throw new Error("ATTACHMENT_UPLOAD_PENDING");
      return reference;
    });
    const inlineByUpload = new Map(
      inlineImagesRef.current.map((image) => [image.uploadFilename, image]),
    );
    const inline = (snapshot.inlineImages ?? []).map((metadata) => {
      const image = inlineByUpload.get(metadata.uploadFilename);
      if (!image) throw new Error("INLINE_ATTACHMENT_UNRESOLVED");
      const retained = workingAttachmentByInlineIdRef.current.get(image.id);
      if (retained) return { ...retained, cid: image.cid, filename: image.uploadFilename };
      const owned = workingAttachmentByFileRef.current.get(image.file);
      if (owned) {
        workingAttachmentByInlineIdRef.current.set(image.id, owned);
        return owned;
      }
      const trustedSource = initial?.attachmentSourceRef ?? initial?.previousRef;
      if (!image.sourceDescriptor && trustedSource) {
        const sourcePart = (initial?.inlineParts ?? []).find(
          (part) => part.cid.trim().replace(/^<|>$/g, "").toLowerCase() === image.cid.toLowerCase(),
        );
        if (sourcePart) {
          image.sourceDescriptor = {
            folderPath: trustedSource.folderPath,
            uid: trustedSource.uid,
            uidValidity: trustedSource.uidValidity,
            part: sourcePart.part,
            cid: image.cid,
            mimeType: image.mimeType,
            filename: sourcePart.part,
            size: sourcePart.size,
            uploadFilename: image.uploadFilename,
          };
        }
      }
      if (!image.sourceDescriptor) throw new Error("INLINE_ATTACHMENT_UNRESOLVED");
      const source = image.sourceDescriptor;
      const reference: WorkingDraftAttachmentReference = {
        clientKey: `provider-inline:${source.folderPath}:${source.uidValidity}:${source.uid}:${source.part}:${source.cid}`,
        kind: "inline-image",
        filename: image.uploadFilename,
        mimeType: image.mimeType,
        size: source.size,
        disposition: "inline",
        cid: image.cid,
        source: {
          folderPath: source.folderPath,
          uid: source.uid,
          uidValidity: source.uidValidity,
          part: source.part,
        },
      };
      workingAttachmentByInlineIdRef.current.set(image.id, reference);
      return reference;
    });
    return { version: 1, snapshot, attachments: [...normal, ...added, ...inline] };
  }

  if (!saverRef.current) {
    saverRef.current = createDraftSaver(draftId, {
      saveRemote: async ({ snapshot, previousRef, generation, trigger, revisionId }) => {
        const token = mailSessionTokenRef.current;
        if (!token) return { ok: false, code: "SESSION_REQUIRED" };
        const logicalRevisionId = revisionId ?? currentRevisionIdRef.current;
        remoteSaveStartedAtByGenerationRef.current.set(generation, performance.now());
        // The interactive save is now the lightweight authoritative Working
        // Draft mutation. It contains body/metadata/reference ids only; the
        // provider checkpoint is scheduled separately and is never awaited by
        // typing, Explicit Save, or Close.
        try {
          const payload = buildWorkingDraftPayload(snapshot);
          const response = await fetch("/api/mail-working-draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mailSessionToken: token,
              action: "save",
              draftId,
              expectedRevision: workingRevisionRef.current,
              payload,
            }),
          });
          const result = (await response.json().catch(() => null)) as {
            ok?: boolean;
            conflict?: boolean;
            revision?: number;
            serverRef?: DraftServerRef | null;
            error?: string;
          } | null;
          if (result?.ok && Number.isSafeInteger(result.revision)) {
            workingRevisionRef.current = result.revision!;
            const hasAttachments = payload.attachments.length > 0;
            if (!sendCompletedRef.current) {
              if (trigger?.reason === "explicit" || trigger?.reason === "close") {
                // Fire-and-forget only: the authoritative Working Draft save
                // above has already completed, so Save and Close never wait for
                // an IMAP APPEND. Starting it now lets a close survive unmount.
                scheduleWorkingDraftCheckpoint(hasAttachments, true);
              } else {
                scheduleWorkingDraftCheckpoint(hasAttachments);
              }
            }
            return { ok: true, serverRef: result.serverRef ?? undefined };
          }
          if (result?.conflict && Number.isSafeInteger(result.revision)) {
            // Never overwrite a newer tab/device. Keep local recovery dirty
            // and require an explicit user retry/reload rather than guessing
            // how to merge mail content.
            workingRevisionRef.current = result.revision!;
            return { ok: false, code: "WORKING_DRAFT_CONFLICT" };
          }
          return { ok: false, code: result?.error || "WORKING_DRAFT_SAVE_FAILED" };
        } catch (error) {
          const code = error instanceof Error ? error.message : "NETWORK";
          if (code !== "NETWORK") {
            console.warn("[draft-save-preflight] failed code=", code);
          }
          return { ok: false, code };
        }

        /* Legacy temporary Bridge-stage path intentionally unreachable. It is
         * retained only for the non-Draft normal-send helpers until their
         * separate paths are deleted in a later compatibility cleanup. */
        const currentFiles = filesRef.current;
        const currentInlineImages = inlineImagesRef.current;
        const transport = serializeInlineImages(snapshot.html, currentInlineImages);
        const usedUploadNames = new Set(
          transport.inlineImages.map((image) => image.uploadFilename),
        );
        const transportImages = currentInlineImages.filter((image) =>
          usedUploadNames.has(image.uploadFilename),
        );
        const transportHtml = sanitizeComposerHtml(transport.html);
        // Bind the attachment signature to THIS request's generation, from
        // the exact attachment values this transport is built from. The
        // signature must never be taken from the live composer refs at
        // completion time — by then the user may have switched to a newer
        // attachment set that this request never transported.
        requestSignatureByGenerationRef.current!.capture(
          generation,
          attachmentSetSignature({
            existingKept: existingKeptRef.current,
            files: currentFiles,
            inlineImages: currentInlineImages,
          }),
        );
        lastDiagnosticAttachmentSignatureRef.current = attachmentSetSignature({
          existingKept: existingKeptRef.current,
          files: currentFiles,
          inlineImages: currentInlineImages,
        });
        try {
          const attachmentPlan = buildAttachmentTransportPlan({
            attachments: existingKeptRef.current,
            restoredHandles: restoredHandleByAttachmentIdRef.current,
            preservedHandles: preservedSourceHandlesRef.current,
            sourceRef: attachmentSourceRef.current,
            // Draft saves send handle + source together: the Bridge reuses the
            // staged bytes when they exist and re-reads IMAP when they don't.
            carryHandleWithSource: true,
          });

          if (attachmentPlan.unresolvedAttachmentIds.length > 0) {
            return { ok: false, code: "SOURCE_ATTACHMENT_UNRESOLVED" };
          }
          const totalAttachmentBytes =
            currentFiles.reduce((sum, file) => sum + file.size, 0) +
            transportImages.reduce((sum, image) => sum + image.file.size, 0);
          const normalParts = existingKeptRef.current.length + currentFiles.length;
          const inlineParts = transportImages.length;
          const saveExceeded = classifyAttachmentLimitExceeded({
            normalAttachmentCount: normalParts,
            inlineImageCount: inlineParts,
            totalBytes: totalAttachmentBytes,
          });
          if (saveExceeded !== null) {
            return { ok: false, code: "ATTACHMENT_LIMIT_EXCEEDED" };
          }
          const stagedFiles = await Promise.all(
            currentFiles.map((file) => ensureStaged(file, "attachment")),
          );
          const uploadInline = transportImages.filter((image) => !image.sourceDescriptor);
          // Inline images that came from the saved draft keep their IMAP
          // descriptor for good, and carry the staged handle as a reuse hint.
          // Reuse makes the save instant; the descriptor keeps it recoverable.
          const restoredInlineSources = transportImages
            .filter((image) => image.sourceDescriptor)
            .map((image) => ({
              ...image.sourceDescriptor!,
              ...(image.stagedHandle ? { handle: image.stagedHandle } : {}),
            }));

          const stagedInline = await Promise.all(
            uploadInline.map((image) => {
              if (image.stagedHandle) {
                return Promise.resolve({
                  kind: "inline-image" as const,
                  handle: image.stagedHandle,
                  filename: image.uploadFilename,
                  size: image.file.size,
                  mimeType: image.mimeType,
                  expiresAt: Number.MAX_SAFE_INTEGER,
                });
              }
              return ensureStaged(image.file, "inline-image", image.uploadFilename);
            }),
          );
          const inlineMetadata = metadataToTransport(uploadInline);
          const attachmentTransport = buildStagedAttachmentTransport({
            plan: attachmentPlan,
            normal: stagedFiles,
            inline: stagedInline,
            inlineMetadata,
          });
          const requestBody = JSON.stringify({
            mailSessionToken: token,
            password: session.password,
            draftId,
            revisionId: logicalRevisionId,
            to: snapshot.to
              .filter((r) => r.valid)
              .map((r) => ({ name: r.name ?? "", email: r.email })),
            cc: snapshot.cc
              .filter((r) => r.valid)
              .map((r) => ({ name: r.name ?? "", email: r.email })),
            bcc: snapshot.bcc
              .filter((r) => r.valid)
              .map((r) => ({ name: r.name ?? "", email: r.email })),
            subject: snapshot.subject,
            inReplyTo: snapshot.inReplyTo,
            references: snapshot.references,
            bodyHtml: transportHtml,
            bodyText: stripHtml(transportHtml),
            previousRef: previousRef ?? undefined,
            diagnostics: trigger,
            sourceInlineImages: restoredInlineSources,
            ...attachmentTransport,
          });
          const attempt = async () => {
            const response = await fetch("/api/mail-draft-save-v2", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: requestBody,
            });
            const value: unknown = await response.json().catch(() => null);
            const parsed =
              value && typeof value === "object" ? (value as Record<string, unknown>) : null;
            return { response, parsed };
          };
          let response: Response;
          let res: Record<string, unknown> | null = null;
          try {
            ({ response, parsed: res } = await attempt());
          } catch {
            ({ response, parsed: res } = await attempt());
          }
          if (!res) {
            try {
              ({ response, parsed: res } = await attempt());
            } catch {
              return { ok: false, code: "NETWORK" };
            }
          }
          if (res?.ok) {
            if (
              res.reconciled !== true &&
              attachmentPlan.sourceAttachmentIds.length &&
              (!Array.isArray(res.sourceAttachmentHandles) ||
                res.sourceAttachmentHandles.length !== attachmentPlan.sourceAttachmentIds.length)
            ) {
              return { ok: false, code: "SOURCE_ATTACHMENT_HANDLE_MISMATCH" };
            }
            if (
              attachmentPlan.sourceAttachmentIds.length &&
              Array.isArray(res.sourceAttachmentHandles)
            ) {
              attachmentPlan.sourceAttachmentIds.forEach((attachmentId, index) => {
                const handle = (res.sourceAttachmentHandles as unknown[])[index];
                if (typeof handle === "string") {
                  preservedSourceHandlesRef.current.set(attachmentId, handle);
                }
              });
            }
            if (
              res.reconciled !== true &&
              restoredInlineSources.length &&
              (!Array.isArray(res.inlineSourceHandles) ||
                res.inlineSourceHandles.length !== restoredInlineSources.length)
            ) {
              return { ok: false, code: "SOURCE_INLINE_HANDLE_MISMATCH" };
            }
            if (restoredInlineSources.length && Array.isArray(res.inlineSourceHandles)) {
              restoredInlineSources.forEach((source, index) => {
                const handle = (res.inlineSourceHandles as unknown[])[index];
                if (typeof handle !== "string") return;
                const image = inlineImagesRef.current.find(
                  (candidate) => candidate.uploadFilename === source.uploadFilename,
                );
                if (image) {
                  // Keep the descriptor: the handle is a reuse hint, not the
                  // only way back to these bytes.
                  image.stagedHandle = handle;
                }
              });
            }
            const nextServerRef: DraftServerRef | null =
              typeof res.uid === "number" &&
              res.uid > 0 &&
              typeof res.uidValidity === "string" &&
              typeof res.folderPath === "string"
                ? {
                    folderPath: res.folderPath,
                    uid: res.uid,
                    uidValidity: res.uidValidity,
                  }
                : null;
            if (res.reconciled === true && nextServerRef) {
              if (attachmentSourceRef.current) attachmentSourceRef.current = nextServerRef;
              for (const image of inlineImagesRef.current) {
                if (!image.sourceDescriptor) continue;
                image.sourceDescriptor = {
                  ...image.sourceDescriptor,
                  ...nextServerRef,
                } as NonNullable<typeof image.sourceDescriptor>;
              }
            }
            const confirmedSnapshot = addStagedMetadata(snapshot);
            if (typeof window !== "undefined" && !sendCompletedRef.current) {
              confirmDraftDocRemoteCommit(window.localStorage, accountEmail, draftId, {
                localRevision: generation,
                revisionId: logicalRevisionId,
                serverRef: nextServerRef ?? null,
                snapshot: confirmedSnapshot,
              });
            }
            persistOwnedTransportCache();
            if (nextServerRef) {
              return {
                ok: true,
                serverRef: nextServerRef ?? undefined,
                reconciled: res.reconciled === true,
              };
            }
            return { ok: true, reconciled: res.reconciled === true };
          }
          const code = String(res?.code ?? res?.error ?? (response.ok ? "UNKNOWN" : "NETWORK"));
          if (code === "INVALID_STAGE_HANDLE" || code === "STAGED_ATTACHMENT_NOT_FOUND") {
            restoredHandleByAttachmentIdRef.current.clear();
            preservedSourceHandlesRef.current.clear();
            restoredInlineHandlesRef.current.clear();
            transportInlineHandleByCidRef.current.clear();
            for (const image of inlineImagesRef.current) image.stagedHandle = undefined;
            clearDraftTransportCache(window.localStorage, accountEmail, draftId);
          }
          return { ok: false, code };
        } catch {
          return { ok: false, code: "NETWORK" };
        }
      },
      onStatus: setSaveStatus,
      onServerRef: (r) => setServerRef(r),
      onCompleted: ({
        completedGeneration,
        revisionId,
        status,
        serverRef,
        previousRef,
        code,
        trigger,
      }) => {
        automaticSaveGenerationsRef.current.delete(completedGeneration);
        const wasAutomatic =
          trigger?.reason === "automatic" || trigger?.reason === "attachment-ready";
        const startedAt = remoteSaveStartedAtByGenerationRef.current.get(completedGeneration);
        remoteSaveStartedAtByGenerationRef.current.delete(completedGeneration);
        // Consume this request's bound attachment signature before any early
        // return so the store cannot grow. Only a size-limit failure may use
        // it to (re)arm the block — and it must attribute the block to the
        // attachment set THIS request transported, never the live refs.
        const requestAttachmentSignature =
          requestSignatureByGenerationRef.current!.consume(completedGeneration);
        if (sendCompletedRef.current) return;
        if (wasAutomatic && status === "saved") {
          lastSuccessfulAutomaticSaveAtRef.current = Date.now();
          if (startedAt != null) {
            lastAutomaticSaveDurationMsRef.current = Math.max(0, performance.now() - startedAt);
          }
        }
        // Advance the clean marker ONLY when a save actually persisted
        // remotely ("saved"). A hard failure (SESSION_REQUIRED, APPEND_FAILED,
        // NETWORK, etc.) MUST leave the composer dirty so the user can retry.
        if (status === "saved") {
          if (completedGeneration > savedGenerationRef.current) {
            draftEngineRef.current?.markSaved(completedGeneration);
            recomputeDirty();
          }
          lastSavedAtRef.current = Date.now();
          setSavedAt(lastSavedAtRef.current);
          lastFailCodeRef.current = null;
          if (typeof window !== "undefined" && revisionId) {
            // "Committed" now means the Working Draft revision, not an IMAP
            // APPEND. This keeps crash recovery clean only for the exact
            // acknowledged generation and retains a later local edit as DIRTY.
            confirmDraftDocRemoteCommit(window.localStorage, accountEmail, draftId, {
              localRevision: completedGeneration,
              revisionId,
              serverRef: serverRef ?? null,
            });
          }
          // A persisted remote save means the attachment set is not
          // size-blocked anymore.
          sizeBlockedAttachmentSignatureRef.current = null;
          setHasRemoteDraft(true);
          const tracked = autosaveRefreshTrackerRef.current!.noteRemoteSave();
          if (tracked.incrementDraftCount) onDraftCreated();
          if (serverRef && typeof window !== "undefined") {
            serverRefRef.current = serverRef;
            updateDraftDocServerRef(window.localStorage, accountEmail, draftId, serverRef);
          }
          if (serverRef) {
            // Record the exact remote identity so a first NOT_FOUND right after
            // this save is protected from destructive ghost cleanup.
            onDraftSaved(
              {
                accountId,
                draftId,
                folderPath: serverRef.folderPath,
                uidValidity: serverRef.uidValidity,
                uid: serverRef.uid,
              },
              previousRef,
            );
          }
        } else if (status === "failed") {
          draftEngineRef.current?.markSaveFailed();
          syncDraftEngineRefs();
          // Diagnostic: capture the coarse code so the UI can surface it
          // (helps distinguish APPEND_FAILED / SAFE_DRAFT_REPLACE_UNSUPPORTED
          // / SESSION_REQUIRED / IMAP_ERROR / UNKNOWN without leaking PII).
          lastFailCodeRef.current = code ?? "UNKNOWN";
          // Authoritative attachment-size rejection (Bridge decoded bytes or
          // the local reliable-byte guard): block ONLY the attachment set this
          // exact request transported. The signature was captured inside
          // saveRemote and is consumed above — the live composer refs at
          // completion time (which may already be a newer set B) are never
          // used to attribute failure of request A.
          if (isAttachmentSizeLimitError(code) && requestAttachmentSignature !== null) {
            sizeBlockedAttachmentSignatureRef.current = requestAttachmentSignature;
          }
          // Also log to the browser console for support triage. No PII.
          try {
            console.error("[draft-save] failed code=", lastFailCodeRef.current);
          } catch {
            /* noop */
          }
        }
        // status === "failed" → no savedGeneration advance, no savedAt bump.
        if (isDirtyRef.current && !deleteIntentRef.current && !sendInProgressRef.current) {
          autosaveRef.current?.schedule();
        }
      },
    });
  }

  const [plainMode, setPlainMode] = useState(false);
  const [fontFamily, setFontFamily] = useState<string>("IBM Plex Sans Arabic, sans-serif");
  const [fontSize, setFontSize] = useState<string>("14px");
  const [blockFmt, setBlockFmt] = useState<string>("p");
  const [extensions, setExtensions] = useState<ComposerExtension[]>(() =>
    typeof window !== "undefined" ? (window.mailmaestroComposerExtensions ?? []) : [],
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imageRangeRef = useRef<Range | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Inline-image affordances (hover toolbar: delete + resize handle).
  const editorWrapRef = useRef<HTMLDivElement | null>(null);
  const activeImgRef = useRef<HTMLImageElement | null>(null);
  const resizingImgRef = useRef(false);
  const imageDragSessionRef = useRef<InlineImageDragSession | null>(null);
  const imageResizeCleanupRef = useRef<(() => void) | null>(null);

  const [imgBox, setImgBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const inlineScope = useMemo(
    () => inlineImageScope(companyId, accountId, draftId),
    [companyId, accountId, draftId],
  );
  const inlineHydratedRef = useRef(false);
  const inlineReadinessRef = useRef<Promise<void>>(Promise.resolve());
  const resolveSourceInlineImages = useMailServerFn(resolveMessageInlineImages);

  // Set initial editor HTML once, then hydrate durable/local or IMAP CID bytes
  // into fresh object URLs. Neither localStorage nor outgoing HTML keeps blob URLs.
  useEffect(() => {
    if (editorRef.current && initialHtml && editorRef.current.innerHTML === "") {
      editorRef.current.innerHTML = initialHtml;
    }
    if (editorRef.current) {
      hydrateComposerDirection(editorRef.current, restored?.dir ?? initial?.direction);
    }
    let cancelled = false;
    const streamController = new AbortController();
    const hydrationKey = "composer-mount-hydration";
    draftEngineRef.current?.registerHydrationDependency(hydrationKey);
    const hydrate = async () => {
      const editor = editorRef.current;
      if (!editor) return;
      const hydrated: InlineComposeImage[] = [];
      const finishHydration = () => {
        if (cancelled) {
          for (const image of hydrated) URL.revokeObjectURL(image.objectUrl);
          return;
        }
        // Local rows already have durable cid/src. Rebind those nodes to fresh object URLs.
        for (const image of hydrated) {
          applyInlineImageToCidNodes(editor, image.cid, image);
        }
        // Any external provider inline resource that has not yet been safely
        // imported remains visible as cid: and blocks a save. It is never
        // silently removed or rebound by filename/MIME.
        for (const unresolved of editor.querySelectorAll<HTMLImageElement>(
          'img[src^="cid:" i],img[data-mm-source-cid]',
        )) {
          if (removeUnresolvedQuotedCidImage(unresolved)) continue;
          const cid = (
            unresolved.dataset.mmSourceCid ??
            unresolved.getAttribute("src")?.slice(4) ??
            ""
          )
            .trim()
            .replace(/^<|>$/g, "")
            .toLowerCase();
          if (!cid) continue;
          unresolved.dataset.mmSourceCid = cid;
          const key = `unresolved-restored-inline:${cid}`;
          unresolvedInlineDependenciesRef.current.set(cid, key);
          draftEngineRef.current?.registerResourceDependency(key);
          draftEngineRef.current?.failResourceDependency(key);
        }
        setInlineImages((current) => mergeHydratedInlineImages(current, hydrated));
        hydratedInlineImageIdsRef.current = new Set([
          ...hydratedInlineImageIdsRef.current,
          ...hydrated.map((image) => image.id),
        ]);
        inlineHydratedRef.current = true;
        if (isDirtyRef.current) autosaveRef.current?.schedule();
      };

      // Wait for the Draft-only Working Draft lookup before deciding whether
      // provider CID hydration is needed. This is what prevents a second-tab
      // open from eagerly FETCHing a provider attachment that MailMaestro
      // already owns durably.
      const workingRecord = await (workingDraftLoadPromiseRef.current ?? Promise.resolve(null));
      if (cancelled) return;
      if (workingRecord) {
        const workingSnapshot = workingRecord.payload.snapshot;
        if (!isDirtyRef.current) {
          editor.innerHTML = workingSnapshot.html ?? "";
          hydrateComposerDirection(editor, workingSnapshot.dir);
        }
        const refsByCid = new Map(
          workingRecord.payload.attachments
            .filter(
              (attachment) =>
                attachment.kind === "inline-image" &&
                Boolean(attachment.attachmentId) &&
                Boolean(attachment.cid),
            )
            .map((attachment) => [
              attachment.cid!.trim().replace(/^<|>$/g, "").toLowerCase(),
              attachment,
            ]),
        );
        const loadedCids = new Set<string>();
        // IndexedDB blobs are accepted only when they are pinned to the same
        // immutable durable attachment id. A reused CID can never surface a
        // previous image from this Draft's local cache.
        try {
          for (const row of await readInlineImages(inlineScope)) {
            const cid = row.cid.trim().replace(/^<|>$/g, "").toLowerCase();
            const reference = refsByCid.get(cid);
            if (!reference || row.workingAttachmentId !== reference.attachmentId) continue;
            const file = new File([row.blob], row.filename, { type: row.mimeType });
            if (!validateInlineImageFile(file).ok) continue;
            const image = hydrateInlineComposeImage(file, row);
            image.workingAttachmentId = reference.attachmentId;
            workingAttachmentByInlineIdRef.current.set(image.id, reference);
            hydrated.push(image);
            loadedCids.add(cid);
          }
        } catch {
          /* Cache is optional; the authenticated private object remains authoritative. */
        }
        for (const [cid, reference] of refsByCid) {
          if (loadedCids.has(cid) || !reference.attachmentId || !reference.cid) continue;
          try {
            const response = await fetch("/api/mail-working-draft-attachment-content", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: streamController.signal,
              body: JSON.stringify({
                mailSessionToken: session.mailSessionToken ?? "",
                draftId,
                attachmentId: reference.attachmentId,
              }),
            });
            if (!response.ok) continue;
            const bytes = await response.blob();
            if (bytes.size !== reference.size) continue;
            const file = new File([bytes], reference.filename, { type: reference.mimeType });
            const snapshotMetadata = (workingSnapshot.inlineImages ?? []).find(
              (item) => item.cid.trim().replace(/^<|>$/g, "").toLowerCase() === cid,
            );
            const metadata = {
              id: snapshotMetadata?.id ?? reference.clientKey,
              cid: reference.cid,
              mimeType: reference.mimeType as InlineImageMime,
              filename: reference.filename,
              uploadFilename: snapshotMetadata?.uploadFilename ?? reference.filename,
              workingAttachmentId: reference.attachmentId,
            };
            const image = reference.source
              ? hydrateSourceInlineComposeImage(file, metadata)
              : hydrateInlineComposeImage(file, metadata);
            workingAttachmentByInlineIdRef.current.set(image.id, reference);
            hydrated.push(image);
            await persistInlineImage(inlineScope, toInlineImageMetadata(image), image.file).catch(
              () => undefined,
            );
          } catch {
            // An owned object that cannot be read remains a visible unresolved
            // cid node and therefore fails closed instead of disappearing.
          }
        }
        finishHydration();
        return;
      }
      if (initial?.quoteSourceHtml) {
        await new Promise<void>((resolve) => {
          let settled = false;
          let timeout = 0;
          const finish = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            resolve();
          };
          requestAnimationFrame(finish);
          timeout = window.setTimeout(finish, 100);
        });
        if (cancelled) return;
        try {
          const prepared = await prepareQuotedEmailForComposer(
            initial.quoteSourceHtml,
            editor.clientWidth,
          );
          if (!cancelled) {
            const quote = editor.querySelector<HTMLElement>("[data-mm-quoted-content]");
            if (quote) quote.innerHTML = prepared;
          }
        } catch {
          // The already-safe fallback quote remains visible with normal whitespace.
        }
      }
      try {
        for (const row of await readInlineImages(inlineScope)) {
          const file = new File([row.blob], row.filename, { type: row.mimeType });
          const image = hydrateInlineComposeImage(file, row);
          image.stagedHandle = restoredInlineHandlesRef.current.get(image.uploadFilename);
          hydrated.push(image);
        }
      } catch {
        /* IndexedDB may be unavailable in private mode; remote save remains available. */
      }
      let remote = initial?.inlineImages ?? [];
      const sourcePartByCid = new Map<
        string,
        { part: string; mimeType: string; size: number; filename: string }
      >();
      for (const source of remote) {
        sourcePartByCid.set(source.cid.toLowerCase(), {
          part: source.part,
          mimeType: source.mimeType,
          size: source.size,
          filename: source.part,
        });
      }
      for (const source of initial?.inlineParts ?? []) {
        if (!sourcePartByCid.has(source.cid.toLowerCase())) {
          sourcePartByCid.set(source.cid.toLowerCase(), {
            part: source.part,
            mimeType: source.mimeType,
            size: source.size,
            filename: source.part,
          });
        }
      }
      const present = new Set(remote.map((item) => item.cid.toLowerCase()));
      const missing = (initial?.inlineParts ?? []).filter(
        (item) => !present.has(item.cid.toLowerCase()),
      );
      const draftPartition = partitionInlineCidParts(missing);
      const batchParts = draftPartition.smallBatchParts;
      const streamedParts = [
        ...draftPartition.largeStreamParts,
        ...draftPartition.overflowStreamParts,
      ];
      const parsed = initial?.inlineMessageId ? parseMessageId(initial.inlineMessageId) : null;
      if (batchParts.length && parsed && initial?.inlineUidValidity && session.mailSessionToken) {
        try {
          const result = await resolveSourceInlineImages({
            data: {
              mailSessionToken: session.mailSessionToken,
              password: session.password,
              folder: parsed.folder,
              uid: parsed.uid,
              uidValidity: initial.inlineUidValidity,
              parts: batchParts,
            },
          });
          if (result.ok) remote = [...remote, ...result.images];
        } catch {
          /* Keep the composer usable; unresolved images remain absent rather than corrupted. */
        }
      }
      const attachRemoteFile = async (sourceCid: string, file: File) => {
        const canonicalSourceCid = sourceCid.trim().replace(/^<|>$/g, "");
        const sourcePart = sourcePartByCid.get(sourceCid.toLowerCase());
        const trustedSource = initial?.attachmentSourceRef ?? initial?.previousRef;
        let image: InlineComposeImage;
        try {
          image =
            sourcePart && trustedSource
              ? createSourceInlineComposeImage(file, canonicalSourceCid)
              : createInlineComposeImage(file);
        } catch {
          return;
        }
        image.stagedHandle = transportInlineHandleByCidRef.current.get(
          canonicalSourceCid.toLowerCase(),
        );
        if (sourcePart && trustedSource) {
          image.sourceDescriptor = {
            folderPath: trustedSource.folderPath,
            uid: trustedSource.uid,
            uidValidity: trustedSource.uidValidity,
            part: sourcePart.part,
            cid: canonicalSourceCid,
            mimeType: image.mimeType,
            filename: sourcePart.filename,
            size: sourcePart.size,
            uploadFilename: image.uploadFilename,
          };
        }
        if (applyInlineImageToCidNodes(editor, sourceCid, image) === 0) {
          URL.revokeObjectURL(image.objectUrl);
          return;
        }
        hydrated.push(image);
        if (image.file.size <= INLINE_IMAGE_MAX_BYTES) {
          await persistInlineImage(inlineScope, toInlineImageMetadata(image), image.file).catch(
            () => undefined,
          );
        }
      };
      for (const source of remote) {
        if (
          !(["image/png", "image/jpeg", "image/gif", "image/webp"] as string[]).includes(
            source.mimeType,
          )
        )
          continue;
        try {
          const file = dataUriToFile(
            source.dataUri,
            "inline-image",
            source.mimeType as InlineImageMime,
          );
          await attachRemoteFile(source.cid, file);
        } catch {
          /* Ignore malformed cached bytes. */
        }
      }
      if (parsed && initial?.inlineUidValidity && session.mailSessionToken) {
        const attachmentTasks: Promise<void>[] = [];
        await streamInlineCidPartsSequential(streamedParts, {
          signal: streamController.signal,
          fetchPart: (part, signal) =>
            fetch("/api/mail-inline-part", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal,
              body: JSON.stringify({
                mailSessionToken: session.mailSessionToken,
                password: session.password,
                folder: parsed.folder,
                uid: parsed.uid,
                uidValidity: initial.inlineUidValidity,
                part: part.part,
              }),
            }),
          onMapping: ({ cid, mimeType, bytes }) => {
            attachmentTasks.push(
              attachRemoteFile(
                cid,
                new File([bytes], "inline-image", { type: mimeType.split(";", 1)[0] }),
              ),
            );
          },
        });
        await Promise.all(attachmentTasks);
      }
      finishHydration();
    };
    inlineReadinessRef.current = hydrate().finally(() => {
      draftEngineRef.current?.settleHydrationDependency(hydrationKey);
      draftEngineRef.current?.completeHydrationWhenReady();
      syncDraftEngineRefs();
    });
    void inlineReadinessRef.current;
    return () => {
      cancelled = true;
      streamController.abort();
      for (const image of inlineImagesRef.current) URL.revokeObjectURL(image.objectUrl);
    };
    // Intentional mount-only hydration: Composer is keyed by draft identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll extension registry occasionally (cheap, only while composer open)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.setInterval(() => {
      const cur = window.mailmaestroComposerExtensions ?? [];
      setExtensions((prev) => (prev.length === cur.length ? prev : [...cur]));
    }, 2000);
    return () => window.clearInterval(id);
  }, []);

  // ----- Track selection formatting state for toolbar highlighting -----
  const [fmtState, setFmtState] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (typeof document === "undefined") return;
    const TOGGLE_CMDS = [
      "bold",
      "italic",
      "underline",
      "strikeThrough",
      "superscript",
      "subscript",
      "justifyLeft",
      "justifyCenter",
      "justifyRight",
      "justifyFull",
      "insertUnorderedList",
      "insertOrderedList",
    ];
    let raf = 0;
    const update = () => {
      const editor = editorRef.current;
      if (!editor) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || !editor.contains(node.nodeType === 1 ? node : node.parentNode)) return;
      const next: Record<string, boolean> = {};
      for (const c of TOGGLE_CMDS) {
        try {
          next[c] = document.queryCommandState(c);
        } catch {
          next[c] = false;
        }
      }
      // Alignment: derive from computed style of nearest block, since we
      // apply text-align directly (execCommand justify* is unreliable).
      try {
        let el: HTMLElement | null =
          node.nodeType === 1 ? (node as HTMLElement) : (node.parentElement as HTMLElement | null);
        while (el && el !== editor) {
          const disp = window.getComputedStyle(el).display;
          if (disp && disp !== "inline" && disp !== "inline-block") break;
          el = el.parentElement;
        }
        const block = (el && el !== editor ? el : editor) as HTMLElement;
        const cs = window.getComputedStyle(block);
        const ta = (cs.textAlign || "").toLowerCase();
        const dir = (cs.direction || "ltr").toLowerCase();
        const isStart = ta === "start" || ta === "" || ta === "-webkit-auto";
        const effective = isStart ? (dir === "rtl" ? "right" : "left") : ta;
        next["justifyLeft"] = effective === "left";
        next["justifyCenter"] = effective === "center";
        next["justifyRight"] = effective === "right";
        next["justifyFull"] = effective === "justify";
      } catch {
        /* noop */
      }
      try {
        const bq = document.queryCommandValue("formatBlock")?.toString().toLowerCase() || "";
        next["blockquote"] = bq === "blockquote";
        const cleanBlock = bq.replace(/[<>]/g, "");
        if (cleanBlock) setBlockFmt(cleanBlock);
      } catch {
        /* noop */
      }
      try {
        const ff = document
          .queryCommandValue("fontName")
          ?.toString()
          .replace(/^['"]|['"]$/g, "");
        if (ff) {
          // match one of our option values whose first family matches
          setFontFamily((prev) => {
            const first = ff.split(",")[0].trim().toLowerCase();
            const prevFirst = prev.split(",")[0].trim().toLowerCase();
            return first === prevFirst ? prev : ff;
          });
        }
      } catch {
        /* noop */
      }
      setFmtState((prev) => {
        for (const k of Object.keys(next)) if (prev[k] !== next[k]) return next;
        return prev;
      });
    };
    const onChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    document.addEventListener("selectionchange", onChange);
    editorRef.current?.addEventListener("keyup", onChange);
    editorRef.current?.addEventListener("mouseup", onChange);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  const inlineBytes = inlineImages.reduce((acc, image) => acc + image.file.size, 0);
  // Hard size validation only counts byte sizes that are genuinely known
  // locally: new Files and hydrated inline-image Files. Existing IMAP
  // server-source attachments only expose BODYSTRUCTURE encoded metadata;
  // their real decoded size is enforced by the Bridge after staging.
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0) + inlineBytes;
  const normalAttachmentCount = files.length + existingKept.length;
  const inlineImageCount = inlineImages.length;

  // Ref mirror so the (persistent) saveRemote closure created at first mount
  // always reads the latest kept-attachment list without being torn down.
  const existingKeptRef = useRef(existingKept);
  useEffect(() => {
    existingKeptRef.current = existingKept;
  }, [existingKept]);

  function addStagedMetadata(snapshot: DraftSnapshot): DraftSnapshot {
    const restored = existingKeptRef.current.flatMap((attachment) => {
      const handle = restoredHandleByAttachmentIdRef.current.get(attachment.id);
      return handle
        ? [
            {
              handle,
              filename: attachment.filename,
              size: attachment.size,
              mimeType: attachment.mimeType,
            },
          ]
        : [];
    });
    const preserved = existingKeptRef.current.flatMap((attachment) => {
      const handle = preservedSourceHandlesRef.current.get(attachment.id);
      return handle
        ? [
            {
              handle,
              filename: attachment.filename,
              size: attachment.size,
              mimeType: attachment.mimeType,
            },
          ]
        : [];
    });
    const added = filesRef.current.flatMap((file) => {
      const staged = getStagedReady(stagedReadyRef.current, file, "attachment", file.name);
      return staged
        ? [
            {
              handle: staged.handle,
              filename: file.name,
              size: file.size,
              mimeType: file.type,
              expiresAt: staged.expiresAt,
            },
          ]
        : [];
    });
    return {
      ...snapshot,
      stagedAttachments: [...restored, ...preserved, ...added],
      sourceAttachments: buildLocalSourceAttachmentState({
        attachments: existingKeptRef.current,
        restoredHandles: restoredHandleByAttachmentIdRef.current,
        preservedHandles: preservedSourceHandlesRef.current,
        sourceRef: attachmentSourceRef.current,
      }),
      inlineImages: snapshot.inlineImages?.map((metadata) => {
        const image = inlineImagesRef.current.find(
          (candidate) => candidate.uploadFilename === metadata.uploadFilename,
        );
        const staged = image
          ? getStagedReady(stagedReadyRef.current, image.file, "inline-image", image.uploadFilename)
          : undefined;
        const handle =
          image?.stagedHandle ??
          restoredInlineHandlesRef.current.get(metadata.uploadFilename) ??
          staged?.handle;
        return handle
          ? { ...metadata, stagedHandle: handle, stagedExpiresAt: staged?.expiresAt }
          : metadata;
      }),
    };
  }

  function persistLocalRecovery(snapshot: DraftSnapshot, generation = generationRef.current) {
    return writeDraftDoc(
      window.localStorage,
      accountEmail,
      {
        version: 3,
        draftId,
        snapshot: addStagedMetadata(snapshot),
        serverRef: serverRefRef.current,
        updatedAt: Date.now(),
        recoveryKind: isEditMode ? "edit" : "new",
        localRevision: generation,
        remoteCommittedRevision: savedGenerationRef.current,
        remoteCommitConfirmed: generation === savedGenerationRef.current,
        revisionId: currentRevisionIdRef.current,
      },
      isEditMode ? "edit" : "new",
    );
  }

  /**
   * Lazily fetch every kept existing attachment as a File, streaming bytes
   * from the bridge via the authenticated proxy (never base64 in JSON). All
   * downloads are cached per-composer-session so autosaves are cheap after
   * the first save. Returns `null` when any attachment fails so the caller
   * can abort — we never silently drop a kept attachment.
   */
  // Publish the latest values to the persistent saveRemote closure refs.
  filesRef.current = files;
  inlineImagesRef.current = inlineImages;
  useEffect(() => {
    for (const file of files) {
      void ensureWorkingAttachment(file, "attachment", {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        disposition: "attachment",
      }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);
  useEffect(() => {
    for (const image of inlineImages) {
      if (hydratedInlineImageIdsRef.current.has(image.id)) continue;
      void ensureWorkingAttachment(image.file, "inline-image", {
        filename: image.uploadFilename,
        mimeType: image.mimeType,
        disposition: "inline",
        cid: image.cid,
      })
        .then((reference) => {
          workingAttachmentByInlineIdRef.current.set(image.id, reference);
          image.workingAttachmentId = reference.attachmentId;
          void persistInlineImage(inlineScope, toInlineImageMetadata(image), image.file).catch(
            () => undefined,
          );
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineImages]);
  // ----- Draft autosave (scheduled): local write first, then remote APPEND -----
  // Persistent, disposable scheduler + input/beforeunload guards. All three
  // helpers expose idempotent .dispose() and are torn down inside useEffect
  // cleanup so no callback runs after unmount.
  const remoteAutosaveTimerRef = useRef<number | null>(null);
  const workingCheckpointTimerRef = useRef<number | null>(null);
  const workingCheckpointInFlightRef = useRef(false);
  const workingCheckpointPendingRef = useRef(false);
  const workingCheckpointFlightRef = useRef<Promise<void> | null>(null);
  const providerCheckpointLatestRequestedRevisionRef = useRef<number | null>(null);
  const providerCheckpointLastCompletedRevisionRef = useRef<number | null>(null);
  const providerCheckpointNextWindowAtRef = useRef<number | null>(null);
  const sendInProgressRef = useRef(false);
  const sendCompletedRef = useRef(false);
  const automaticRemoteSaveInFlightRef = useRef<Promise<unknown> | null>(null);
  const lastSuccessfulAutomaticSaveAtRef = useRef<number | null>(null);
  const lastAutomaticSaveDurationMsRef = useRef<number | null>(null);
  const automaticSaveGenerationsRef = useRef(new Set<number>());
  const autosaveScheduleReasonRef = useRef<DraftSaveTriggerReason>("automatic");

  function startWorkingDraftCheckpoint(hasAttachments: boolean) {
    void hasAttachments;
    if (
      !canScheduleWorkingDraftCheckpoint({
        sendInProgress: sendInProgressRef.current,
        deleteIntent: deleteIntentRef.current,
        sendCompleted: sendCompletedRef.current,
      })
    ) {
      return;
    }
    const latestRevision = workingRevisionRef.current;
    if (
      !shouldRunProviderCheckpoint({
        latestWorkingRevision: latestRevision,
        lastCheckpointedRevision: providerCheckpointLastCompletedRevisionRef.current ?? 0,
      })
    ) {
      workingCheckpointPendingRef.current = false;
      return;
    }
    if (typeof window === "undefined" || workingCheckpointInFlightRef.current) {
      providerCheckpointLatestRequestedRevisionRef.current = Math.max(
        providerCheckpointLatestRequestedRevisionRef.current ?? 0,
        latestRevision,
      );
      workingCheckpointPendingRef.current = true;
      return;
    }
    if (workingCheckpointTimerRef.current !== null) {
      window.clearTimeout(workingCheckpointTimerRef.current);
      workingCheckpointTimerRef.current = null;
    }
    workingCheckpointPendingRef.current = false;
    workingCheckpointInFlightRef.current = true;
    const checkpointRevision = Math.max(
      providerCheckpointLatestRequestedRevisionRef.current ?? 0,
      latestRevision,
    );
    providerCheckpointLatestRequestedRevisionRef.current = checkpointRevision;
    console.info("[draft-provider-checkpoint] event=start revision=", checkpointRevision);
    workingCheckpointFlightRef.current = fetch("/api/mail-working-draft-checkpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mailSessionToken: mailSessionTokenRef.current, draftId }),
    })
      .then(async (response) => {
        if (response.ok) {
          const result = (await response.json().catch(() => null)) as {
            ok?: boolean;
            skipped?: boolean;
            fenced?: boolean;
            revision?: number;
          } | null;
          if (result?.ok && Number.isSafeInteger(result.revision)) {
            providerCheckpointLastCompletedRevisionRef.current = Math.max(
              providerCheckpointLastCompletedRevisionRef.current ?? 0,
              result.revision!,
            );
          } else if (result?.ok && result.skipped && !result.fenced) {
            providerCheckpointLastCompletedRevisionRef.current = Math.max(
              providerCheckpointLastCompletedRevisionRef.current ?? 0,
              checkpointRevision,
            );
          }
          console.info("[draft-provider-checkpoint] event=complete revision=", checkpointRevision);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        workingCheckpointInFlightRef.current = false;
        workingCheckpointFlightRef.current = null;
        if (
          workingCheckpointPendingRef.current &&
          canScheduleWorkingDraftCheckpoint({
            sendInProgress: sendInProgressRef.current,
            deleteIntent: deleteIntentRef.current,
            sendCompleted: sendCompletedRef.current,
          })
        ) {
          scheduleWorkingDraftCheckpoint(hasAttachments, true);
        }
      });
  }

  function scheduleWorkingDraftCheckpoint(hasAttachments: boolean, immediate = false) {
    void hasAttachments;
    if (
      typeof window === "undefined" ||
      !canScheduleWorkingDraftCheckpoint({
        sendInProgress: sendInProgressRef.current,
        deleteIntent: deleteIntentRef.current,
        sendCompleted: sendCompletedRef.current,
      })
    ) {
      return;
    }
    const latestRevision = workingRevisionRef.current;
    providerCheckpointLatestRequestedRevisionRef.current = Math.max(
      providerCheckpointLatestRequestedRevisionRef.current ?? 0,
      latestRevision,
    );
    workingCheckpointPendingRef.current = true;
    if (workingCheckpointInFlightRef.current) return;
    if (immediate) {
      if (workingCheckpointTimerRef.current !== null) {
        window.clearTimeout(workingCheckpointTimerRef.current);
        workingCheckpointTimerRef.current = null;
      }
      providerCheckpointNextWindowAtRef.current = Date.now() + DRAFT_PROVIDER_CHECKPOINT_CADENCE_MS;
      startWorkingDraftCheckpoint(hasAttachments);
      return;
    }
    if (workingCheckpointTimerRef.current !== null) return;
    const now = Date.now();
    const nextWindowAt =
      providerCheckpointNextWindowAtRef.current ?? now + DRAFT_PROVIDER_CHECKPOINT_CADENCE_MS;
    providerCheckpointNextWindowAtRef.current = nextWindowAt;
    const delay = Math.max(0, nextWindowAt - now);
    console.info("[draft-provider-checkpoint] event=scheduled revision=", latestRevision);
    workingCheckpointTimerRef.current = window.setTimeout(() => {
      workingCheckpointTimerRef.current = null;
      if (
        !workingCheckpointPendingRef.current ||
        !canScheduleWorkingDraftCheckpoint({
          sendInProgress: sendInProgressRef.current,
          deleteIntent: deleteIntentRef.current,
          sendCompleted: sendCompletedRef.current,
        })
      ) {
        return;
      }
      startWorkingDraftCheckpoint(hasAttachments);
    }, delay);
  }
  const pendingRemoteSaveRef = useRef<{
    snapshot: DraftSnapshot;
    generation: number;
    hasAttachments: boolean;
    reason: DraftSaveTriggerReason;
    revisionId: string;
  } | null>(null);
  // Latest snapshot fields captured for the scheduler's callback (avoids
  // stale-closure reads without re-instantiating the scheduler each render).
  const snapshotInputsRef = useRef({
    to,
    cc,
    bcc,
    subject,
    showCc,
    showBcc,
    accountEmail,
    sending,
    existingKeptLen: existingKept.length,
    filesLen: files.length,
    inlineLen: inlineImages.length,
  });
  snapshotInputsRef.current = {
    to,
    cc,
    bcc,
    subject,
    showCc,
    showBcc,
    accountEmail,
    sending,
    existingKeptLen: existingKept.length,
    filesLen: files.length,
    inlineLen: inlineImages.length,
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flushPendingRemoteSave = () => {
      remoteAutosaveTimerRef.current = null;
      const pending = pendingRemoteSaveRef.current;
      if (!pending) return;
      if (
        !canStartRemoteAutosave({
          sending: sendInProgressRef.current,
          dirty: isDirtyRef.current,
          deleteIntent: deleteIntentRef.current,
        })
      ) {
        if (sendInProgressRef.current || deleteIntentRef.current || !isDirtyRef.current) {
          pendingRemoteSaveRef.current = null;
        }
        return;
      }
      if (saverRef.current?.isBusy() || draftEngineRef.current?.state === "SAVING") return;
      // Attachment-size block: after an authoritative size failure the same
      // attachment set must not be re-downloaded every autosave tick. The
      // local draft was already written by the scheduler before this ran.
      // Manual Save/Send never go through this path and stay allowed.
      const sizeBlockDecision = decideAttachmentSizeBlock({
        blockedSignature: sizeBlockedAttachmentSignatureRef.current,
        currentSignature: attachmentSetSignature({
          existingKept: existingKeptRef.current,
          files: filesRef.current,
          inlineImages: inlineImagesRef.current,
        }),
      });
      if (sizeBlockDecision.clearBlock) sizeBlockedAttachmentSignatureRef.current = null;
      if (!sizeBlockDecision.remoteSaveAllowed) {
        pendingRemoteSaveRef.current = null;
        return;
      }
      if (!draftEngineRef.current?.beginSave()) {
        return;
      }
      pendingRemoteSaveRef.current = null;
      automaticSaveGenerationsRef.current.add(pending.generation);
      const savePromise = saverRef.current?.requestSave(
        pending.snapshot,
        serverRefRef.current,
        pending.generation,
        makeDraftSaveTriggerDiagnostics(pending.reason, pending.generation),
        pending.revisionId,
      );
      if (savePromise) {
        automaticRemoteSaveInFlightRef.current = savePromise;
        void savePromise.then(
          () => {
            if (automaticRemoteSaveInFlightRef.current === savePromise) {
              automaticRemoteSaveInFlightRef.current = null;
            }
          },
          () => {
            if (automaticRemoteSaveInFlightRef.current === savePromise) {
              automaticRemoteSaveInFlightRef.current = null;
            }
          },
        );
      }
    };
    const scheduler = createAutosaveScheduler({
      delayMs: DRAFT_REMOTE_IDLE_MS,
      maxDelayMs: DRAFT_MAX_DIRTY_MS,
      onFire: () => {
        const s = snapshotInputsRef.current;
        if (s.sending || sendInProgressRef.current) return;
        // DELETE INTENT fence: block any new autosave (local write + remote).
        if (deleteIntentRef.current) return;
        if (!isDirtyRef.current) return;
        if (!inlineHydratedRef.current) return;
        const serialized = serializeInlineImages(
          editorRef.current?.innerHTML ?? "",
          inlineImagesRef.current,
          {
            keepEditorIds: true,
            preserveUnresolvedCid: true,
          },
        );
        const html = serialized.html;
        const isEmpty = isDraftEmpty({
          toCount: s.to.length,
          ccCount: s.cc.length,
          bccCount: s.bcc.length,
          subject: s.subject,
          htmlTrimmed: html.trim(),
          existingKeptCount: s.existingKeptLen,
          filesCount: s.filesLen + s.inlineLen,
        });
        if (isEmpty) {
          clearDraftDoc(window.localStorage, s.accountEmail, draftId);
          setHasLocalDraft(false);
          setSavedAt(null);
          setSaveStatus("idle");
          // Empty draft = nothing to persist; treat current gen as saved.
          draftEngineRef.current?.markSaved(generationRef.current);
          recomputeDirty();
          return;
        }
        const snapshot = addStagedMetadata({
          to: s.to,
          cc: s.cc,
          bcc: s.bcc,
          subject: s.subject,
          html,
          dir: currentEditorDirection(),
          showCc: s.showCc,
          showBcc: s.showBcc,
          ...threadingHeaders,
          inlineImages: serialized.inlineImages,
        });
        const genAtFire = generationRef.current;
        const persisted = persistLocalRecovery(snapshot, genAtFire);
        if (!persisted) {
          setSaveStatus("failed");
          return;
        }
        setHasLocalDraft(true);
        // Capture generation at schedule-fire time and pass it into the
        // saver. `savedGeneration` will only advance when onCompleted echoes
        // this exact value (or a newer coalesced one) — a stale response
        // can never mark newer content clean.
        const hasAttachments = s.existingKeptLen + s.filesLen + s.inlineLen > 0;
        const reason = autosaveScheduleReasonRef.current;
        autosaveScheduleReasonRef.current = "automatic";
        pendingRemoteSaveRef.current = {
          snapshot,
          generation: genAtFire,
          hasAttachments,
          reason,
          revisionId: currentRevisionIdRef.current,
        };
        if (remoteAutosaveTimerRef.current !== null) {
          window.clearTimeout(remoteAutosaveTimerRef.current);
        }
        // Working Draft saves are small JSON/reference mutations. They must
        // not inherit the expensive IMAP APPEND cooldown: the scheduler above
        // already provides the 1.5s idle / 5s max-dirty cadence.
        void hasAttachments;
        remoteAutosaveTimerRef.current = window.setTimeout(flushPendingRemoteSave, 0);
      },
    });
    autosaveRef.current = scheduler;
    return () => {
      scheduler.dispose();
      autosaveRef.current = null;
      if (remoteAutosaveTimerRef.current !== null) {
        window.clearTimeout(remoteAutosaveTimerRef.current);
        remoteAutosaveTimerRef.current = null;
      }
      if (workingCheckpointTimerRef.current !== null) {
        window.clearTimeout(workingCheckpointTimerRef.current);
        workingCheckpointTimerRef.current = null;
      }
    };
  }, [draftId, threadingHeaders]);

  // Reschedule whenever any user-editable field changes (body edits bump
  // bodyRev via the input listener below; recipient/subject/attachment
  // changes flow through the deps array).
  useEffect(() => {
    autosaveRef.current?.schedule();
  }, [to, cc, bcc, subject, showCc, showBcc, existingKept, files, bodyRev]);

  // Editor body input listener — attached via a disposable helper so cleanup
  // runs exactly once. Per spec: `input` event on the editor body ONLY.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const disposable = attachInputListener(el, () => {
      const ids = new Set(
        Array.from(el.querySelectorAll<HTMLElement>("[data-mm-inline-id]"))
          .map((node) => node.dataset.mmInlineId)
          .filter((id): id is string => Boolean(id)),
      );
      const removed = inlineImagesRef.current.filter((image) => !ids.has(image.id));
      if (removed.length) {
        for (const image of removed) {
          abandonedUploadsRef.current.add(image.file);
          const dependency = fileDependencyByFileRef.current.get(image.file);
          if (dependency) {
            draftEngineRef.current?.cancelResourceDependency(dependency.key);
            fileDependencyByFileRef.current.delete(image.file);
          }
          URL.revokeObjectURL(image.objectUrl);
          void deleteInlineImage(inlineScope, image.id).catch(() => undefined);
          const staged = getStagedReady(
            stagedReadyRef.current,
            image.file,
            "inline-image",
            image.uploadFilename,
          );
          const restoredHandle = restoredInlineHandlesRef.current.get(image.uploadFilename);
          const handle = staged?.handle ?? restoredHandle;
          if (handle) {
            releaseStagedHandle(handle, () => {
              stagedReadyRef.current.get(image.file)?.delete("inline-image");
              restoredInlineHandlesRef.current.delete(image.uploadFilename);
            });
          }
        }
        setInlineImages((current) => current.filter((image) => ids.has(image.id)));
      }
      const liveUnresolved = new Set(
        Array.from(
          el.querySelectorAll<HTMLImageElement>('img[src^="cid:" i],img[data-mm-source-cid]'),
        ).map((image) =>
          (image.dataset.mmSourceCid ?? image.getAttribute("src")?.slice(4) ?? "")
            .trim()
            .replace(/^<|>$/g, "")
            .toLowerCase(),
        ),
      );
      for (const [cid, key] of unresolvedInlineDependenciesRef.current) {
        if (liveUnresolved.has(cid)) continue;
        draftEngineRef.current?.cancelResourceDependency(key);
        unresolvedInlineDependenciesRef.current.delete(cid);
      }
      setBodyRev((n) => n + 1);
      markEdited();
    });
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mark edited on structural field changes (recipients, subject, attachments).
  const editMarkMountedRef = useRef(false);
  useEffect(() => {
    if (!editMarkMountedRef.current) {
      editMarkMountedRef.current = true;
      return;
    }
    if (suppressNextServerHydrationDirtyRef.current) {
      suppressNextServerHydrationDirtyRef.current = false;
      return;
    }
    markEdited();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, showCc, showBcc, existingKept]);

  // ----- Guarded close: intercept close attempts when there are unsaved changes -----
  const closePromptRef = useRef(closePrompt);
  useEffect(() => {
    closePromptRef.current = closePrompt;
  }, [closePrompt]);

  // Single-flight close: the FIRST requestClose creates one shared Promise.
  // Any concurrent requestClose (rapid X click, Escape, folder switch, etc.)
  // returns that same Promise without opening a second dialog or replacing
  // the existing resolver. Cleared on Cancel / after onClose so a later
  // attempt can start fresh.
  const closeFlowRef = useRef<Promise<boolean> | null>(null);
  // Single reusable clean-close finalization. Clears the crash-recovery local
  // Draft document + inline-image cache ONLY when safe: either an explicitly
  // confirmed remote save, or a genuinely clean composer whose content is
  // already safely represented remotely. A dirty composer, a failed save, or a
  // local-only unsaved draft never reaches this — crash recovery is preserved.
  const finalizeCleanClose = (opts?: { confirmedSavedServer?: boolean }) => {
    if (typeof window === "undefined") return;
    const safelyRemote = shouldFinalizeCleanClose({
      isDirty: isDirtyRef.current,
      serverRef: serverRefRef.current,
      saveStatus: saverRef.current?.getStatus() ?? "idle",
      confirmedSavedServer: opts?.confirmedSavedServer,
    });
    if (!safelyRemote) return;
    try {
      persistOwnedTransportCache();
      clearDraftDoc(window.localStorage, accountEmail, draftId);
      void clearInlineImages(inlineScope).catch(() => undefined);
    } catch {
      /* noop */
    }
    setHasLocalDraft(false);
  };
  const closeComposer = () => {
    onClose({
      refreshDrafts: autosaveRefreshTrackerRef.current?.consumeCloseRefresh() ?? false,
    });
  };
  async function requestClose(): Promise<boolean> {
    if (deleteIntentRef.current) return false;
    if (closeFlowRef.current) return closeFlowRef.current;
    const flow = (async (): Promise<boolean> => {
      if (deleteIntentRef.current) return false;
      // CLEAN composer closes immediately — whether or not it carries content.
      // Only a DIRTY composer prompts (Save / Discard / Cancel). A confirmed-
      // saved (or otherwise safely-remote) clean composer finalizes the local
      // recovery doc so a later New Message never resurrects it.
      if (!isDirtyRef.current) {
        finalizeCleanClose();
        scheduleWorkingDraftCheckpoint(
          existingKeptRef.current.length +
            filesRef.current.length +
            inlineImagesRef.current.length >
            0,
          true,
        );
        closeComposer();
        return true;
      }

      const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
        setClosePrompt({ resolve });
      });
      if (deleteIntentRef.current) return false;
      if (choice === "cancel") {
        closeIntentAfterUploadRef.current = null;
        // Release the single-flight so the user can try again.
        return false;
      }
      if (choice === "save") {
        if (draftEngineRef.current?.hasPendingDependencies()) {
          closeIntentAfterUploadRef.current = generationRef.current;
          toast.info(tr("الملف لا يزال قيد الرفع. سيتم الحفظ والإغلاق بعد اكتماله."));
          return false;
        }
        const result = await saveDraftNow("close");
        // Only a confirmed remote save may close. Failed / empty keeps the
        // composer open so nothing is silently lost.
        if (result === "saved_server") {
          finalizeCleanClose({ confirmedSavedServer: true });
          closeComposer();
          return true;
        }
        return false;
      }
      // discard
      deleteIntentRef.current = true;
      closeIntentAfterUploadRef.current = null;
      draftEngineRef.current?.beginDiscard();
      autosaveRef.current?.cancel();
      workingCheckpointPendingRef.current = false;
      if (workingCheckpointTimerRef.current !== null) {
        window.clearTimeout(workingCheckpointTimerRef.current);
        workingCheckpointTimerRef.current = null;
      }
      if (remoteAutosaveTimerRef.current !== null) {
        window.clearTimeout(remoteAutosaveTimerRef.current);
        remoteAutosaveTimerRef.current = null;
      }
      pendingRemoteSaveRef.current = null;
      for (const file of filesRef.current) abandonedUploadsRef.current.add(file);
      for (const image of inlineImagesRef.current) abandonedUploadsRef.current.add(image.file);
      await saverRef.current?.cancelPendingAndAwaitRunning();
      const token = session.mailSessionToken;
      if (!token) {
        deleteIntentRef.current = false;
        for (const file of filesRef.current) abandonedUploadsRef.current.delete(file);
        for (const image of inlineImagesRef.current) abandonedUploadsRef.current.delete(image.file);
        draftEngineRef.current?.completeDeleteFailure();
        syncDraftEngineRefs();
        toast.error(tr("تعذّر حذف المسودة. احتفظنا بنسختك؛ حاول مرة أخرى."));
        return false;
      }
      let discarded = false;
      try {
        discarded = (
          await discardServerWorkingDraft({
            serverRef: serverRefRef.current ?? initial?.previousRef ?? null,
            previousRef: initial?.previousRef ?? null,
          })
        ).ok;
      } catch {
        discarded = false;
      }
      if (!discarded) {
        deleteIntentRef.current = false;
        for (const file of filesRef.current) abandonedUploadsRef.current.delete(file);
        for (const image of inlineImagesRef.current) abandonedUploadsRef.current.delete(image.file);
        draftEngineRef.current?.completeDeleteFailure();
        syncDraftEngineRefs();
        toast.error(tr("تعذّر حذف المسودة. احتفظنا بنسختك؛ حاول مرة أخرى."));
        return false;
      }
      try {
        clearDraftDoc(window.localStorage, accountEmail, draftId);
        clearDraftTransportCache(window.localStorage, accountEmail, draftId);
        void clearInlineImages(inlineScope).catch(() => undefined);
      } catch {
        /* best effort after confirmed remote delete */
      }
      // Discard abandons every staged handle owned by this composer session.
      releaseAllOwnedStagedHandles();
      // A discarded draft must no longer be protected from ghost cleanup.
      onDraftDeleted(draftId);
      // Force clean so beforeunload/guard don't re-trap on the way out.
      draftEngineRef.current?.resetForDiscard();
      lastSavedAtRef.current = Date.now();
      recomputeDirty();
      closeComposer();
      return true;
    })().finally(() => {
      // Release single-flight AFTER the flow settles. On close (onClose
      // called) the component is unmounting so this ref is discarded anyway.
      closeFlowRef.current = null;
    });
    closeFlowRef.current = flow;
    return flow;
  }

  // Expose a global guard so parent nav actions (folder switch, list click,
  // new-message button) can prompt before tearing the composer down.
  const requestCloseRef = useRef<() => Promise<boolean>>(async () => {
    closeComposer();
    return true;
  });
  requestCloseRef.current = requestClose;
  useEffect(() => {
    (
      window as unknown as { __mailmaestroComposerGuard?: () => Promise<boolean> }
    ).__mailmaestroComposerGuard = () => requestCloseRef.current();
    // Native beforeunload prompt — trapped ONLY while dirty. Disposable so
    // the listener is removed exactly once on unmount.
    const guard = attachBeforeUnloadGuard(window, () => isDirtyRef.current);
    return () => {
      const w = window as unknown as {
        __mailmaestroComposerGuard?: (() => Promise<boolean>) | null;
      };
      if (w.__mailmaestroComposerGuard) w.__mailmaestroComposerGuard = null;
      guard.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    const merged: File[] = [...files];
    const added: File[] = [];
    let runningTotal = totalBytes;
    let runningNormal = normalAttachmentCount;
    for (const f of incoming) {
      if (runningNormal >= COMPOSE_MAX_NORMAL_ATTACHMENTS) {
        toast.error(tr("الحد الأقصى للمرفقات هو 10 ملفات"));
        break;
      }
      if (runningTotal + f.size > COMPOSE_MAX_TOTAL_BYTES) {
        toast.error(tr("تجاوزت حدود المرفقات المسموحة"));
        break;
      }
      merged.push(f);
      added.push(f);
      runningTotal += f.size;
      runningNormal += 1;
    }
    setFiles(merged);
    markEdited();
    for (const file of added) {
      const key = `new-file:${newDraftId()}`;
      draftEngineRef.current?.registerResourceDependency(key);
      fileDependencyByFileRef.current.set(file, { key });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeExistingAttachment(id: string) {
    setExistingKept((prev) => {
      const next = prev.filter((a) => a.id !== id);
      existingKeptRef.current = next;
      return next;
    });
    const restoredHandle = restoredHandleByAttachmentIdRef.current.get(id);
    const preservedHandle = preservedSourceHandlesRef.current.get(id);
    const handle = restoredHandle ?? preservedHandle;
    if (!handle) {
      restoredHandleByAttachmentIdRef.current.delete(id);
      preservedSourceHandlesRef.current.delete(id);
      return;
    }
    releaseStagedHandle(handle, () => {
      restoredHandleByAttachmentIdRef.current.delete(id);
      preservedSourceHandlesRef.current.delete(id);
    });
  }

  function removeFile(index: number) {
    const file = files[index];
    setFiles((prev) => prev.filter((_, i) => i !== index));
    markEdited();
    if (!file) return;
    abandonedUploadsRef.current.add(file);
    const dep = fileDependencyByFileRef.current.get(file);
    if (dep) {
      draftEngineRef.current?.cancelResourceDependency(dep.key);
      fileDependencyByFileRef.current.delete(file);
    }
    const staged = getStagedReady(stagedReadyRef.current, file, "attachment", file.name);
    if (!staged?.handle) return;
    releaseStagedHandle(staged.handle, () => {
      stagedReadyRef.current.get(file)?.delete("attachment");
      stagedUploadsRef.current.get(file)?.delete("attachment");
    });
  }

  function mutateEditor(mutation: () => void): boolean {
    const editor = editorRef.current;
    if (!editor) return false;
    return mutateEditorWithSingleInput(editor, mutation);
  }

  function exec(command: string, value?: string) {
    if (typeof document === "undefined") return;
    editorRef.current?.focus();
    mutateEditor(() => {
      try {
        document.execCommand(command, false, value);
      } catch {
        /* noop */
      }
    });
    // execCommand doesn't always fire selectionchange (esp. for alignment);
    // force toolbar state refresh.
    try {
      document.dispatchEvent(new Event("selectionchange"));
    } catch {
      /* noop */
    }
  }

  function alignEditorContent(alignment: InlineImageAlignment) {
    const image = activeImgRef.current;
    const editor = editorRef.current;
    if (image && editor?.contains(image)) {
      alignActiveImage(alignment);
      return;
    }
    exec(
      alignment === "left"
        ? "justifyLeft"
        : alignment === "center"
          ? "justifyCenter"
          : "justifyRight",
    );
  }

  function currentEditorDirection(): "rtl" | "ltr" {
    const editor = editorRef.current;
    const explicit = editor?.getAttribute("dir");
    if (explicit === "rtl" || explicit === "ltr") return explicit;
    if (editor && typeof window !== "undefined") {
      const computed = window.getComputedStyle(editor).direction;
      if (computed === "rtl" || computed === "ltr") return computed;
    }
    return document.documentElement.dir === "ltr" ? "ltr" : "rtl";
  }

  function promptLink() {
    const url = window.prompt(tr("رابط URL (يبدأ بـ https://):"), "https://");
    if (!url) return;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) {
        toast.error(tr("رابط غير مدعوم"));
        return;
      }
      exec("createLink", u.toString());
    } catch {
      toast.error(tr("رابط غير صالح"));
    }
  }

  function insertHtmlAtCursor(html: string) {
    editorRef.current?.focus();
    mutateEditor(() => {
      try {
        document.execCommand("insertHTML", false, html);
      } catch {
        /* noop */
      }
    });
  }

  function applyFontFamily(family: string) {
    if (!family) return;
    exec("fontName", family);
  }
  function applyFontSize(px: string) {
    if (!px || !editorRef.current) return;
    editorRef.current.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      // No selection: apply to next typed via a span
      insertHtmlAtCursor(`<span style="font-size:${px}">\u200B</span>`);
      return;
    }
    const range = sel.getRangeAt(0);
    const span = document.createElement("span");
    span.style.fontSize = px;
    mutateEditor(() => {
      try {
        span.appendChild(range.extractContents());
        range.insertNode(span);
        const newRange = document.createRange();
        newRange.selectNodeContents(span);
        sel.removeAllRanges();
        sel.addRange(newRange);
      } catch {
        /* noop */
      }
    });
  }
  function applyForeColor(color: string) {
    exec("foreColor", color);
  }
  function applyBackColor(color: string) {
    // hiliteColor works in Firefox/Chrome; backColor as fallback
    editorRef.current?.focus();
    mutateEditor(() => {
      try {
        if (!document.execCommand("hiliteColor", false, color)) {
          document.execCommand("backColor", false, color);
        }
      } catch {
        /* noop */
      }
    });
  }
  function setEditorDirection(dir: "rtl" | "ltr") {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    const sel = window.getSelection();
    const findBlock = (n: Node | null): HTMLElement => {
      let cur: Node | null = n;
      while (cur && cur !== root) {
        if (cur.nodeType === 1) {
          const el = cur as HTMLElement;
          const disp = window.getComputedStyle(el).display;
          if (disp && disp !== "inline" && disp !== "inline-block") return el;
        }
        cur = cur.parentNode;
      }
      return root;
    };
    const blocks = new Set<HTMLElement>();
    if (sel && sel.rangeCount > 0) {
      for (let i = 0; i < sel.rangeCount; i++) {
        const r = sel.getRangeAt(i);
        blocks.add(findBlock(r.startContainer));
        blocks.add(findBlock(r.endContainer));
      }
    }
    if (blocks.size === 0) blocks.add(root);
    mutateEditor(() => {
      root.dir = dir;
      root.style.textAlign = dir === "rtl" ? "right" : "left";
      if (blocks.delete(root)) {
        let directionBlock =
          root.childElementCount === 1 &&
          root.firstElementChild instanceof HTMLElement &&
          root.firstElementChild.dataset.mmEditorDirection === "1"
            ? root.firstElementChild
            : null;
        if (!directionBlock) {
          directionBlock = document.createElement("div");
          directionBlock.dataset.mmEditorDirection = "1";
          while (root.firstChild) directionBlock.append(root.firstChild);
          root.append(directionBlock);
        }
        blocks.add(directionBlock);
      }
      blocks.forEach((el) => {
        el.setAttribute("dir", dir);
        el.style.textAlign = dir === "rtl" ? "right" : "left";
      });
    });
  }
  function toggleEditorDirection() {
    const root = editorRef.current;
    if (!root) return;
    const sel = window.getSelection();
    let refEl: HTMLElement = root;
    if (sel && sel.rangeCount > 0) {
      let n: Node | null = sel.getRangeAt(0).startContainer;
      while (n && n !== root) {
        if (n.nodeType === 1) {
          const el = n as HTMLElement;
          const disp = window.getComputedStyle(el).display;
          if (disp && disp !== "inline" && disp !== "inline-block") {
            refEl = el;
            break;
          }
        }
        n = n.parentNode;
      }
    }
    const cur = refEl.getAttribute("dir") || window.getComputedStyle(refEl).direction || "rtl";
    setEditorDirection(cur === "rtl" ? "ltr" : "rtl");
  }
  function insertHR() {
    exec("insertHorizontalRule");
  }
  function promptImage() {
    // Save the caret before the file dialog steals focus.
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    imageRangeRef.current =
      sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)
        ? sel.getRangeAt(0).cloneRange()
        : null;
    imageInputRef.current?.click();
  }

  async function insertImageFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (!picked.length) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor?.focus();
    let range = imageRangeRef.current;
    const added: InlineComposeImage[] = [];
    for (const file of picked) {
      const valid = validateInlineImageFile(file);
      if (!valid.ok) {
        toast.error(
          valid.reason === "size"
            ? tr("حجم الصورة كبير جداً (الحد 5MB)")
            : tr("نوع الصورة غير مدعوم"),
        );
        continue;
      }
      if (inlineImageCount + added.length > COMPOSE_MAX_INLINE_IMAGES) {
        toast.error(tr("تجاوزت الرسالة الحد المسموح للصور المضمنة"));
        continue;
      }
      if (
        totalBytes + added.reduce((n, image) => n + image.file.size, 0) + file.size >
        COMPOSE_MAX_TOTAL_BYTES
      ) {
        toast.error(tr("تجاوزت حدود المرفقات المسموحة"));
        continue;
      }
      const image = createInlineComposeImage(file);
      try {
        await persistInlineImage(inlineScope, toInlineImageMetadata(image), image.file);
      } catch {
        URL.revokeObjectURL(image.objectUrl);
        toast.error(tr("تعذّر حفظ الصورة محلياً"));
        continue;
      }
      const node = insertInlineImageNode(editor, image, range);
      range = document.createRange();
      range.setStartAfter(node);
      range.collapse(true);
      added.push(image);
    }
    imageRangeRef.current = null;
    if (added.length) {
      setInlineImages((current) => [...current, ...added]);
      notifyEditorChange();
      for (const image of added) {
        const key = `new-inline:${image.id}`;
        draftEngineRef.current?.registerResourceDependency(key);
        fileDependencyByFileRef.current.set(image.file, { key });
      }
    }
  }

  /* ---- Inline image manipulation (hover delete + drag move + resize) ---- */

  const syncImgBox = useCallback((img: HTMLImageElement | null) => {
    const wrap = editorWrapRef.current;
    if (!img || !wrap || !wrap.contains(img)) {
      activeImgRef.current = null;
      setImgBox(null);
      return;
    }
    const a = img.getBoundingClientRect();
    const b = wrap.getBoundingClientRect();
    activeImgRef.current = img;
    setImgBox({
      top: a.top - b.top,
      left: a.left - b.left,
      width: a.width,
      height: a.height,
    });
  }, []);

  // Track hovered/clicked images. Dragging itself is owned by an overlay
  // outside contentEditable so Chromium never starts a native edit gesture.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || plainMode) return;
    const pick = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.tagName === "IMG" && t.dataset.mmInlineId) {
        (t as HTMLImageElement).draggable = false;
        syncImgBox(t as HTMLImageElement);
      }
    };
    const refresh = () => syncImgBox(activeImgRef.current);
    const removeSelectionListener = installInlineImageSelectionListener({
      editor,
      getActiveImage: () => activeImgRef.current,
      onSelect: syncImgBox,
      beforeClear: () => {
        imageDragSessionRef.current?.cancel();
        imageResizeCleanupRef.current?.();
      },
      onClear: () => syncImgBox(null),
    });

    editor.addEventListener("mouseover", pick);
    editor.addEventListener("pointerdown", pick);
    editor.addEventListener("click", pick);
    editor.addEventListener("input", refresh);
    editor.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    return () => {
      editor.removeEventListener("mouseover", pick);
      editor.removeEventListener("pointerdown", pick);
      editor.removeEventListener("click", pick);
      editor.removeEventListener("input", refresh);
      editor.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
      removeSelectionListener();
    };
  }, [plainMode, syncImgBox]);

  useEffect(
    () => () => {
      imageDragSessionRef.current?.cancel();
      imageDragSessionRef.current = null;
      imageResizeCleanupRef.current?.();
      imageResizeCleanupRef.current = null;
    },
    [],
  );

  function notifyEditorChange() {
    editorRef.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function deleteActiveImage() {
    const img = activeImgRef.current;
    if (!img) return;
    const editor = editorRef.current;
    if (!editor) return;
    removeInlineImageNode(img, editor);
    syncImgBox(null);
  }

  function startImageDrag(e: React.PointerEvent<HTMLButtonElement>) {
    const image = activeImgRef.current;
    const editor = editorRef.current;
    if (!image || !editor || resizingImgRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    imageDragSessionRef.current?.cancel();
    imageDragSessionRef.current = startInlineImageDragSession(e.nativeEvent, {
      editor,
      image,
      onCommit: (movedImage) => {
        const selectionRange = document.createRange();
        selectionRange.setStartAfter(movedImage);
        selectionRange.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(selectionRange);
      },
      onCleanup: () => {
        imageDragSessionRef.current = null;
      },
    });
  }

  function alignActiveImage(alignment: InlineImageAlignment) {
    const image = activeImgRef.current;
    const editor = editorRef.current;
    if (!image || !editor) return;
    alignInlineImageNode(image, editor, alignment);
    requestAnimationFrame(() => {
      if (editor.contains(image)) syncImgBox(image);
    });
  }

  function startImageResize(e: React.PointerEvent<HTMLButtonElement>) {
    const img = activeImgRef.current;
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    // The handle always sits on the visual right edge (position is computed
    // from getBoundingClientRect), so growth is always "drag right" — never
    // mirror the delta for RTL, that inverted the gesture.
    resizingImgRef.current = true;
    img.draggable = false;
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const editorWidth = editorRef.current?.clientWidth ?? startW;
    let frame = 0;
    let finished = false;
    const move = (ev: PointerEvent) => {
      const next = clampInlineImageWidth(startW + (ev.clientX - startX), editorWidth);
      img.style.width = `${next}px`;
      img.style.height = "auto";
      img.style.maxWidth = "100%";
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncImgBox(img));
    };
    const up = () => {
      if (finished) return;
      finished = true;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      cancelAnimationFrame(frame);
      resizingImgRef.current = false;
      imageResizeCleanupRef.current = null;
      img.draggable = false;
      notifyEditorChange();
    };
    imageResizeCleanupRef.current = up;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  const extensionContext = {
    getHtml: () => editorRef.current?.innerHTML ?? "",
    setHtml: (h: string) => {
      mutateEditor(() => {
        if (editorRef.current) editorRef.current.innerHTML = h;
      });
    },
    insertHtml: insertHtmlAtCursor,
    getSubject: () => subject,
    setSubject,
    getRecipients: () => ({
      to: to.map((r) => r.email),
      cc: cc.map((r) => r.email),
      bcc: bcc.map((r) => r.email),
    }),
  };

  async function performSend() {
    if (sendInProgressRef.current) {
      toast.info(tr("جاري الإرسال"));
      return;
    }
    sendInProgressRef.current = true;
    setSending(true);
    setSendProgress({ progress: 8, stage: "preparing" });
    let sendAccepted = false;
    let deliveryProgressTimer: number | null = null;
    const startDeliveryProgress = () => {
      if (deliveryProgressTimer !== null) window.clearInterval(deliveryProgressTimer);
      const startedAt = performance.now();
      setSendProgress({ progress: 72, stage: "delivering" });
      deliveryProgressTimer = window.setInterval(() => {
        const progress = deliveryProgressForElapsed(performance.now() - startedAt);
        setSendProgress((current) =>
          current.stage === "delivering" && progress > current.progress
            ? { progress, stage: "delivering" }
            : current,
        );
      }, 500);
    };
    const stopDeliveryProgress = () => {
      if (deliveryProgressTimer === null) return;
      window.clearInterval(deliveryProgressTimer);
      deliveryProgressTimer = null;
    };
    try {
      console.info("[draft-send] phase=send-click");
      autosaveRef.current?.cancel();
      if (remoteAutosaveTimerRef.current !== null) {
        window.clearTimeout(remoteAutosaveTimerRef.current);
        remoteAutosaveTimerRef.current = null;
      }
      if (workingCheckpointTimerRef.current !== null) {
        window.clearTimeout(workingCheckpointTimerRef.current);
        workingCheckpointTimerRef.current = null;
      }
      workingCheckpointPendingRef.current = false;
      pendingRemoteSaveRef.current = null;
      console.info("[draft-send] phase=provider-checkpoint-not-awaited");
      await inlineReadinessRef.current;
      setSendProgress({ progress: 20, stage: "preparing" });
      // Settle any currently-running Draft autosave before deciding whether a
      // send-time Working Draft persistence pass is required. This never lets
      // an autosave rejection leak into the Send flow.
      setSendProgress({ progress: 24, stage: "saving" });
      await saverRef.current?.cancelPendingAndAwaitRunning();
      setSendProgress({ progress: 30, stage: "saving" });
      syncDraftEngineRefs();
      const serialized = serializeInlineImages(
        editorRef.current?.innerHTML ?? "",
        inlineImagesRef.current,
      );
      const usedUploadNames = new Set(serialized.inlineImages.map((image) => image.uploadFilename));
      const transportImages = inlineImagesRef.current.filter((image) =>
        usedUploadNames.has(image.uploadFilename),
      );
      const fragment = sanitizeComposerHtml(serialized.html);
      // Recipients don't get the app stylesheet: carry every bit of spacing /
      // list / typography formatting inline in a standalone email document.
      const editorDir = currentEditorDirection();
      const bodyHtml = buildEmailHtmlDocument(fragment, { dir: editorDir });
      const bodyText = htmlToPlainText(fragment);
      setSendProgress({ progress: 42, stage: "preparing" });

      // A normal, never-saved Compose continues through the existing SMTP
      // path unchanged. An actual Draft (server Working Draft or provider
      // Draft being edited) sends from the durable Working Draft objects.
      const draftOrigin = isEditMode || workingRevisionRef.current > 0;
      let response: Response;
      if (draftOrigin) {
        setSendProgress({ progress: 52, stage: "saving" });
        // isEditMode alone must never authorize /api/mail-working-draft-send.
        // A clean provider/legacy Draft is promoted into a real Working Draft
        // row here, without fabricating a user edit, before SMTP is allowed.
        const needsWorkingDraftPersist = draftSendNeedsWorkingDraftPersist({
          workingRevision: workingRevisionRef.current,
          dirty: isDirtyRef.current,
        });
        const saved = needsWorkingDraftPersist
          ? await saveDraftNow("send", {
              forceWorkingDraftPersist: workingRevisionRef.current <= 0,
            })
          : "saved_server";
        if (saved !== "saved_server") {
          return;
        }
        if (workingRevisionRef.current <= 0) {
          toast.error(tr("تعذّر تجهيز المسودة للإرسال. أعد المحاولة."));
          return;
        }
        startDeliveryProgress();
        response = await fetch("/api/mail-working-draft-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mailSessionToken: session.mailSessionToken ?? "",
            draftId,
          }),
        });
      } else {
        const attachmentPlan = buildAttachmentTransportPlan({
          attachments: existingKeptRef.current,
          restoredHandles: restoredHandleByAttachmentIdRef.current,
          preservedHandles: preservedSourceHandlesRef.current,
          sourceRef: attachmentSourceRef.current,
        });
        if (attachmentPlan.unresolvedAttachmentIds.length > 0) {
          toast.error(tr("تعذّر تجهيز مرفقات الرسالة"));
          return;
        }
        let stagedNormal: StagedAttachmentResult[];
        let stagedInline: StagedAttachmentResult[];
        const uploadInline = transportImages.filter((image) => !image.sourceDescriptor);
        const sourceInlineImages = transportImages
          .filter((image) => image.sourceDescriptor)
          .map((image) => image.sourceDescriptor!);
        const hasAttachmentsToTransfer =
          files.length > 0 ||
          uploadInline.length > 0 ||
          attachmentPlan.sourceAttachments.length > 0 ||
          sourceInlineImages.length > 0;
        setSendProgress({
          progress: 52,
          stage: hasAttachmentsToTransfer ? "uploading" : "preparing",
        });
        try {
          stagedNormal = await Promise.all(files.map((file) => ensureStaged(file, "attachment")));
          stagedInline = await Promise.all(
            uploadInline.map((image) =>
              ensureStaged(image.file, "inline-image", image.uploadFilename),
            ),
          );
        } catch {
          toast.error(tr("تعذّر رفع أحد المرفقات"));
          return;
        }
        const attachmentTransport = buildStagedAttachmentTransport({
          plan: attachmentPlan,
          normal: stagedNormal,
          inline: stagedInline,
          inlineMetadata: metadataToTransport(uploadInline),
        });
        startDeliveryProgress();
        response = await fetch("/api/mail-send-v2", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mailSessionToken: session.mailSessionToken ?? "",
            password: session.password,
            to: to.filter((r) => r.valid).map((r) => ({ name: r.name ?? "", email: r.email })),
            cc: cc.filter((r) => r.valid).map((r) => ({ name: r.name ?? "", email: r.email })),
            bcc: bcc.filter((r) => r.valid).map((r) => ({ name: r.name ?? "", email: r.email })),
            subject,
            inReplyTo: threadingHeaders.inReplyTo,
            references: threadingHeaders.references,
            bodyHtml,
            bodyText,
            sourceInlineImages,
            ...attachmentTransport,
          }),
        });
      }
      stopDeliveryProgress();
      setSendProgress({ progress: 90, stage: "confirming" });
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const result = (await response.json().catch(() => ({
        ok: false,
        error: `HTTP ${response.status}`,
      }))) as {
        ok: boolean;
        error?: string;
        messageId?: string;
        sentCopySaved?: boolean;
        sentCopyPending?: boolean;
        sentCopyJobId?: string;
        sentCopyState?: SentCopyState;
      };
      if (!result.ok) {
        toast.error(
          isAttachmentSizeLimitError(result.error)
            ? tr("تجاوزت حدود المرفقات المسموحة")
            : isAttachmentPreparationProtocolError(result.error)
              ? tr(ATTACHMENT_PREPARATION_MESSAGE_KEY)
              : result.error || tr("فشل إرسال الرسالة"),
        );
        return;
      }
      sendAccepted = true;
      sendCompletedRef.current = true;
      setSendProgress({ progress: 100, stage: "complete" });
      // Let the browser visibly complete the real 100% state before the
      // successful composer close unmounts this panel.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 360));
      console.info("[draft-send] phase=smtp-accepted");
      // Clear draft on successful send: local wipe + best-effort server delete,
      // with any failure re-queued so the next composer mount can retry it.
      try {
        clearDraftDoc(window.localStorage, accountEmail, draftId);
        clearDraftTransportCache(window.localStorage, accountEmail, draftId);
        void clearInlineImages(inlineScope).catch(() => undefined);
      } catch {
        /* noop */
      }
      if (draftOrigin) {
        // Optimistically remove the sent logical Draft from the Draft list and
        // decrement the count exactly once. onDraftDeleted below clears the
        // snapshot; later refetch reconciliation cannot double-decrement.
        onDraftDeleteStart(draftId, { activateDraftCountGuard: true });
      }
      if (!draftOrigin) {
        // Preserve the existing normal-send Draft cleanup behaviour. The
        // durable Working Draft endpoint owns its cleanup after its send path.
        const refAtSend = serverRefRef.current;
        const hadServerCopy = !!refAtSend || saveStatus !== "idle";
        if (hadServerCopy) {
          const token = session.mailSessionToken ?? "";
          const automaticSaveAtSend = automaticRemoteSaveInFlightRef.current;
          deleteDraftAfterSend({
            deleteRemote: async () => {
              await automaticSaveAtSend?.catch(() => undefined);
              try {
                clearDraftDoc(window.localStorage, accountEmail, draftId);
              } catch {
                /* remote cleanup must still run if local storage is unavailable */
              }
              const deleted = await bridgeDeleteDraftFn({
                data: {
                  mailSessionToken: token,
                  draftId,
                  previousRef: refAtSend ?? undefined,
                },
              });
              return !!deleted?.ok;
            },
            onFailure: () => {
              pendingQueueRef.current?.enqueue(accountEmail, {
                draftId,
                previousRef: refAtSend,
              });
            },
          });
        }
        // An attachment-bearing Compose may have begun its upload-once Draft
        // lifecycle just before its first Working Draft JSON save. It still
        // sent through the unchanged normal SMTP path above, so dispose that
        // private shell afterwards. This is deliberately fire-and-forget:
        // normal Send never waits for Draft cleanup, and the server's FK plus
        // failed-insert cleanup also covers an upload that wins this race.
        if (filesRef.current.length > 0 || inlineImagesRef.current.length > 0) {
          void deleteServerWorkingDraft();
        }
      }
      toast.success(tr("تم إرسال الرسالة"));
      // A sent draft is gone — clear any just-saved readability marker.
      onDraftDeleted(draftId);
      onClose({ refreshDrafts: false });
      onSent({
        messageId: result.messageId,
        sentCopySaved: result.sentCopySaved === true,
        sentCopyPending: result.sentCopyPending === true,
        sentCopyJobId: result.sentCopyJobId,
        sentCopyState: result.sentCopyState,
        draftOrigin,
      });
      console.info("[draft-send] phase=ui-complete");
      // Address book: record recipients AFTER a successful SMTP send only.
      // Never let this failure poison the send outcome.
      try {
        const own = (session.account.email_address ?? "").toLowerCase().trim();
        const collected: Array<{ email: string; name: string | null }> = [];
        const seen = new Set<string>();
        for (const r of [...to, ...cc, ...bcc]) {
          if (!r.valid) continue;
          const e = r.email.toLowerCase();
          if (!e || e === own || seen.has(e)) continue;
          seen.add(e);
          collected.push({ email: e, name: r.name ?? null });
        }
        if (collected.length > 0) {
          void recordLocalSend(companyId, accountId, collected);
          const token = session.mailSessionToken;
          if (token) {
            void recordSuggestions({
              data: { mailSessionToken: token, recipients: collected },
            }).catch(() => {
              /* fire-and-forget */
            });
          }
        }
      } catch {
        /* noop — never fail the send */
      }
    } catch (err: unknown) {
      toast.error(errorMessage(err, tr("فشل إرسال الرسالة")));
    } finally {
      stopDeliveryProgress();
      sendInProgressRef.current = false;
      setSending(false);
      setSendProgress({ progress: 0, stage: "preparing" });
      if (!sendAccepted && isDirtyRef.current) autosaveRef.current?.schedule();
    }
  }

  async function handleSend() {
    if (to.length === 0) {
      toast.error(tr("أضف مستلماً واحداً على الأقل"));
      return;
    }
    const invalid = [...to, ...cc, ...bcc].filter((r) => !r.valid);
    if (invalid.length > 0) {
      toast.error(trf("عنوان بريد غير صالح: {{email}}", { email: invalid[0].email }));
      return;
    }
    const exceeded = classifyAttachmentLimitExceeded({
      normalAttachmentCount,
      inlineImageCount,
      totalBytes,
    });
    if (exceeded !== null) {
      toast.error(
        exceeded === "bytes"
          ? tr("تجاوزت حدود المرفقات المسموحة")
          : exceeded === "inline"
            ? tr("تجاوزت الرسالة الحد المسموح للصور المضمنة")
            : tr("الحد الأقصى للمرفقات هو 10 ملفات"),
      );
      return;
    }
    if (!subject.trim()) {
      const ok = window.confirm(tr("لا يوجد موضوع. هل ترغب في الإرسال على أي حال؟"));
      if (!ok) return;
    }
    // Attachment-mention detector
    const html = editorRef.current?.innerHTML ?? "";
    const text = stripHtml(html).toLowerCase();
    const mentionsAttach = /(attach|attached|attachment|مرفق|مرفقات|المرفق)/.test(text);
    if (mentionsAttach && existingKept.length + files.length === 0) {
      const ok = window.confirm(tr("ذكرت مرفقاً لكن لم تُضِف أي ملف. هل تريد الإرسال دون مرفق؟"));
      if (!ok) return;
    }
    await performSend();
  }

  // Keyboard shortcuts (Ctrl/Cmd+Enter to send, Esc to minimize)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
      } else if (e.key === "Escape") {
        e.preventDefault();
        void requestClose();
      }
    }
    const el = containerRef.current;
    el?.addEventListener("keydown", onKey);
    return () => el?.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    to,
    cc,
    bcc,
    subject,
    files,
    existingKept,
    inlineImages,
    normalAttachmentCount,
    inlineImageCount,
    totalBytes,
  ]);

  // Inline mode: composer fills the message-viewer pane on the same
  // light bg-surface used elsewhere, wrapped in an elegant card.
  const containerClass = "relative flex h-full w-full flex-col bg-surface";

  const savedLabel = (() => {
    const t = savedAt
      ? new Date(savedAt).toLocaleTimeString(getCurrentLang() === "ar" ? "ar-SA" : "en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    switch (saveStatus) {
      case "saving":
        return tr("جارٍ الحفظ…");
      case "saved":
        return t ? trf("تم الحفظ {{time}}", { time: t }) : tr("تم الحفظ");
      case "failed":
        return tr("تعذّر الحفظ");
      default:
        return "";
    }
  })();

  type SaveNowResult = "saved_server" | "failed" | "empty";
  async function saveDraftNow(
    reason: DraftSaveTriggerReason = "explicit",
    options?: { forceWorkingDraftPersist?: boolean },
  ): Promise<SaveNowResult> {
    if (typeof window === "undefined") return "failed";
    if (deleteIntentRef.current) return "failed";
    const exceeded = classifyAttachmentLimitExceeded({
      normalAttachmentCount,
      inlineImageCount,
      totalBytes,
    });
    if (exceeded !== null) {
      toast.error(
        exceeded === "bytes"
          ? tr("تجاوزت حدود المرفقات المسموحة")
          : exceeded === "inline"
            ? tr("تجاوزت الرسالة الحد المسموح للصور المضمنة")
            : tr("الحد الأقصى للمرفقات هو 10 ملفات"),
      );
      return "failed";
    }
    // Any pending automatic save must not race this explicit/Close request.
    autosaveRef.current?.cancel();
    if (remoteAutosaveTimerRef.current !== null) {
      window.clearTimeout(remoteAutosaveTimerRef.current);
      remoteAutosaveTimerRef.current = null;
    }
    pendingRemoteSaveRef.current = null;
    // Explicit Save / Save-before-Send must never be rejected just because an
    // automatic save is currently running. Cancel any coalesced follow-up,
    // settle the running save, then re-read the latest dirty/generation state.
    await saverRef.current?.cancelPendingAndAwaitRunning();
    await inlineReadinessRef.current;

    for (let attemptNumber = 0; attemptNumber < 5; attemptNumber += 1) {
      if (deleteIntentRef.current) return "failed";
      const forceWorkingDraftPersist =
        options?.forceWorkingDraftPersist === true && workingRevisionRef.current <= 0;
      if (
        !forceWorkingDraftPersist &&
        isCleanRemoteDraft({
          isDirty: isDirtyRef.current,
          hasRemoteDraft,
          serverRef: serverRefRef.current,
          isEditMode,
        })
      ) {
        toast.success(tr("تم حفظ المسودّة"));
        return "saved_server";
      }
      const serialized = serializeInlineImages(
        editorRef.current?.innerHTML ?? "",
        inlineImagesRef.current,
        {
          keepEditorIds: true,
          preserveUnresolvedCid: true,
        },
      );
      const html = serialized.html;
      // Unified emptiness contract with autosave: a draft that carries
      // attachments (new OR kept legacy) is NOT empty even without text.
      const isEmpty = isDraftEmpty({
        toCount: to.length,
        ccCount: cc.length,
        bccCount: bcc.length,
        subject,
        htmlTrimmed: html.trim(),
        existingKeptCount: existingKeptRef.current.length,
        filesCount: filesRef.current.length + inlineImagesRef.current.length,
      });
      if (isEmpty) {
        toast.info(tr("لا يوجد محتوى للحفظ"));
        return "empty";
      }
      const genAtRequest = generationRef.current;
      const revisionIdAtRequest = currentRevisionIdRef.current;
      const snapshot = addStagedMetadata({
        to,
        cc,
        bcc,
        subject,
        html,
        dir: currentEditorDirection(),
        showCc,
        showBcc,
        ...threadingHeaders,
        inlineImages: serialized.inlineImages,
      });
      const persisted = persistLocalRecovery(snapshot, genAtRequest);
      if (!persisted) {
        setSaveStatus("failed");
        toast.error(tr("تعذّر حفظ المسودّة"));
        return "failed";
      }
      setHasLocalDraft(true);
      const engine = draftEngineRef.current;
      if (!engine || engine.hasPendingDependencies() || engine.hasFailedDependencies()) {
        toast.error(
          engine?.hasPendingDependencies()
            ? tr("الملف لا يزال قيد الرفع. انتظر اكتماله ثم حاول مجدداً.")
            : tr("تعذّر تجهيز أحد محتويات المسودّة للحفظ."),
        );
        return "failed";
      }
      const completion = await saverRef.current?.requestSave(
        snapshot,
        serverRefRef.current,
        genAtRequest,
        makeDraftSaveTriggerDiagnostics(reason, genAtRequest),
        revisionIdAtRequest,
      );
      if (deleteIntentRef.current) return "failed";
      if (completion?.status === "saved") {
        engine.markSaved(completion.completedGeneration);
        syncDraftEngineRefs();
        if (isDirtyRef.current) continue;
        toast.success(tr("تم حفظ المسودّة"));
        return "saved_server";
      }
      // Hard failure — do NOT show a "success" toast.
      const failCode = lastFailCodeRef.current ?? "UNKNOWN";
      toast.error(
        isAttachmentSizeLimitError(failCode)
          ? tr("تجاوزت حدود المرفقات المسموحة")
          : trf("تعذّر حفظ المسودّة على الخادم — حاول لاحقاً ({{code}})", { code: failCode }),
      );
      return "failed";
    }
    return "failed";
  }

  // "Save as Draft" toolbar action: remote-save the latest generation and
  // close the composer immediately on confirmation. On failure the composer
  // stays open and dirty. If the user typed while the save was in flight, the
  // loop re-captures and saves the newest generation before closing. After the
  // bounded loop, the composer closes ONLY if the latest generation was
  // remotely saved AND the composer is still clean — never while dirty.
  async function handleSaveAsDraft() {
    if (deleteIntentRef.current) return;
    let result: SaveNowResult = "empty";
    for (let attempt = 0; attempt < 5; attempt++) {
      result = await saveDraftNow("explicit");
      if (result !== "saved_server" || !isDirtyRef.current) break;
    }
    if (result === "saved_server" && !isDirtyRef.current) {
      finalizeCleanClose({ confirmedSavedServer: true });
      closeComposer();
    }
  }

  async function handleDeleteDraft() {
    // DELETE INTENT fence: guards duplicate clicks (before the await) AND
    // blocks every new autosave for the whole delete lifecycle.
    if (deletingDraft || deleteIntentRef.current) return;
    deleteIntentRef.current = true;
    const confirmed = await confirm({
      title: tr("حذف المسودة؟"),
      description: tr("سيتم حذف النسخة المحفوظة نهائياً. لا يمكن التراجع عن هذا الإجراء."),
      confirmLabel: tr("حذف المسودة"),
      cancelLabel: tr("إلغاء"),
      variant: "destructive",
    });
    if (!confirmed) {
      deleteIntentRef.current = false;
      return;
    }

    setDeletingDraft(true);
    draftEngineRef.current?.beginDelete();
    autosaveRef.current?.cancel();
    workingCheckpointPendingRef.current = false;
    if (workingCheckpointTimerRef.current !== null) {
      window.clearTimeout(workingCheckpointTimerRef.current);
      workingCheckpointTimerRef.current = null;
    }
    closeIntentAfterUploadRef.current = null;
    for (const file of filesRef.current) abandonedUploadsRef.current.add(file);
    for (const image of inlineImagesRef.current) abandonedUploadsRef.current.add(image.file);
    onDraftDeleteStart(draftId);
    // Wait for any in-flight remote save (running AND coalesced) to settle so
    // the delete never races a still-running APPEND from this composer. The
    // latest serverRef is guaranteed to be settled before the delete starts.
    await saverRef.current?.cancelPendingAndAwaitRunning();
    const deleted = await discardServerWorkingDraft({
      serverRef: serverRefRef.current ?? initial?.previousRef ?? null,
      previousRef: initial?.previousRef ?? null,
    });

    if (!deleted.ok) {
      draftEngineRef.current?.completeDeleteFailure();
      syncDraftEngineRefs();
      setDeletingDraft(false);
      deleteIntentRef.current = false;
      for (const file of filesRef.current) abandonedUploadsRef.current.delete(file);
      for (const image of inlineImagesRef.current) abandonedUploadsRef.current.delete(image.file);
      onDraftDeleteRollback(draftId);
      // Keep the coarse, PII-safe failure code for diagnostics (never PII).
      try {
        console.error("[draft-delete] failed code=", deleted.code);
      } catch {
        /* noop */
      }
      // DO NOT re-arm autosave here: it resumes only on a NEW user edit, so a
      // failed Delete can never immediately trigger another remote save.
      toast.error(tr("تعذّر حذف المسودة. احتفظنا بنسختك؛ حاول مرة أخرى."));
    } else {
      try {
        clearDraftDoc(window.localStorage, accountEmail, draftId);
        clearDraftTransportCache(window.localStorage, accountEmail, draftId);
        void clearInlineImages(inlineScope).catch(() => undefined);
      } catch {
        /* best effort after durable discard ack */
      }
      // Explicit draft delete abandons every staged handle owned by this
      // composer session (the draft will no longer reference them).
      releaseAllOwnedStagedHandles();
      // A deleted draft must no longer be protected from ghost cleanup.
      onDraftDeleted(draftId);
      onClose({ refreshDrafts: true });
      // deleteIntentRef stays true; the composer unmounts via closeWithRefresh.
    }
  }

  return (
    <div
      ref={containerRef}
      className={containerClass}
      role="dialog"
      aria-label={tr("إنشاء رسالة")}
      tabIndex={-1}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
        setDragging(false);
      }}
    >
      {sending && <SendProgressPanel state={sendProgress} />}
      {/* Header — flush with the pane, on the same surface */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-surface/80 px-3 py-2.5 backdrop-blur sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-brand sm:h-9 sm:w-9">
            <Send className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {subject || tr("رسالة جديدة")}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {session.account.email_address}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">{savedLabel}</span>
          <button
            onClick={() => void requestClose()}
            className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title={tr("إغلاق (Esc)")}
            aria-label={tr("إغلاق")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body — full width, scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-none flex-col gap-4 px-3 py-4 sm:px-6 sm:py-5">
          {/* Recipients */}
          <RecipientField
            label={tr("المرسل له")}
            value={to}
            onChange={setTo}
            autoFocus
            getSuggestions={suggestFor}
            onHideSuggestion={hideOne}
            rightSlot={
              <div className="flex shrink-0 flex-wrap items-center gap-1 sm:border-s sm:border-border/60 sm:ps-2 sm:me-2">
                {!showCc && (
                  <button
                    type="button"
                    onClick={() => setShowCc(true)}
                    className="inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-primary"
                  >
                    {tr("نسخة إلى")}
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    onClick={() => setShowBcc(true)}
                    className="inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-primary"
                  >
                    {tr("نسخة مخفية إلى")}
                  </button>
                )}
              </div>
            }
          />
          {showCc && (
            <RecipientField
              label={tr("نسخة إلى")}
              value={cc}
              onChange={setCc}
              getSuggestions={suggestFor}
              onHideSuggestion={hideOne}
            />
          )}
          {showBcc && (
            <RecipientField
              label={tr("نسخة مخفية إلى")}
              value={bcc}
              onChange={setBcc}
              getSuggestions={suggestFor}
              onHideSuggestion={hideOne}
            />
          )}

          {/* Subject */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">{tr("الموضوع")}</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={tr("اكتب موضوع الرسالة")}
              className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* Editor */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium text-foreground">{tr("نص الرسالة")}</label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title={plainMode ? tr("الوضع المنسّق") : tr("الوضع النصّي")}
                  onClick={() => setPlainMode((v) => !v)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Type className="h-3.5 w-3.5" />
                </button>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      title={tr("خيارات متقدمة")}
                      aria-label={tr("خيارات متقدمة")}
                      onMouseDown={(e) => e.preventDefault()}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                      <span>{tr("متقدم")}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto p-2">
                    <div className="grid grid-cols-6 gap-0.5">
                      <ToolbarButton
                        title={tr("يتوسطه خط")}
                        active={fmtState.strikeThrough}
                        onMouseDown={() => exec("strikeThrough")}
                      >
                        <Strikethrough className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("مرتفع")}
                        active={fmtState.superscript}
                        onMouseDown={() => exec("superscript")}
                      >
                        <Superscript className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("منخفض")}
                        active={fmtState.subscript}
                        onMouseDown={() => exec("subscript")}
                      >
                        <Subscript className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("ضبط")}
                        active={fmtState.justifyFull}
                        onMouseDown={() => exec("justifyFull")}
                      >
                        <AlignJustify className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("زيادة المسافة البادئة")}
                        onMouseDown={() => exec("indent")}
                      >
                        <Indent className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("تقليل المسافة البادئة")}
                        onMouseDown={() => exec("outdent")}
                      >
                        <Outdent className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("اقتباس")}
                        active={fmtState.blockquote}
                        onMouseDown={() => exec("formatBlock", "blockquote")}
                      >
                        <Quote className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton title={tr("إدراج صورة")} onMouseDown={promptImage}>
                        <ImageIcon className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton title={tr("خط أفقي")} onMouseDown={insertHR}>
                        <Minus className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("تبديل اتجاه النص RTL/LTR")}
                        onMouseDown={toggleEditorDirection}
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title={tr("إزالة التنسيق")}
                        onMouseDown={() => exec("removeFormat")}
                      >
                        <Eraser className="h-3.5 w-3.5" />
                      </ToolbarButton>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-input bg-background transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
              {!plainMode && (
                <div className="flex flex-wrap items-center gap-0.5 border-b border-border/70 bg-muted/30 px-2 py-1.5">
                  {/* Font family */}
                  <ToolbarSelect
                    title={tr("الخط")}
                    ariaLabel={tr("الخط")}
                    placeholder={tr("الخط")}
                    value={fontFamily}
                    onChange={(v) => {
                      setFontFamily(v);
                      applyFontFamily(v);
                    }}
                    className="min-w-[7.5rem]"
                    options={[
                      { value: "IBM Plex Sans Arabic, sans-serif", label: "IBM Plex Sans Arabic" },
                      { value: "Cairo, sans-serif", label: "Cairo" },
                      { value: "Tajawal, sans-serif", label: "Tajawal" },
                      { value: "Amiri, serif", label: "Amiri" },
                      { value: "Arial, sans-serif", label: "Arial" },
                      { value: "Georgia, serif", label: "Georgia" },
                      { value: "Times New Roman, serif", label: "Times New Roman" },
                      { value: "Courier New, monospace", label: "Courier New" },
                      { value: "Tahoma, sans-serif", label: "Tahoma" },
                      { value: "Verdana, sans-serif", label: "Verdana" },
                    ]}
                  />
                  {/* Font size */}
                  <ToolbarSelect
                    title={tr("حجم الخط")}
                    ariaLabel={tr("حجم الخط")}
                    placeholder={tr("الحجم")}
                    value={fontSize}
                    onChange={(v) => {
                      setFontSize(v);
                      applyFontSize(v);
                    }}
                    className="min-w-[4.5rem]"
                    options={[
                      { value: "10px", label: "10" },
                      { value: "12px", label: "12" },
                      { value: "14px", label: "14" },
                      { value: "16px", label: "16" },
                      { value: "18px", label: "18" },
                      { value: "20px", label: "20" },
                      { value: "24px", label: "24" },
                      { value: "28px", label: "28" },
                      { value: "32px", label: "32" },
                    ]}
                  />
                  {/* Paragraph */}
                  <ToolbarSelect
                    title={tr("نمط الفقرة")}
                    ariaLabel={tr("نمط الفقرة")}
                    placeholder={tr("الفقرة")}
                    value={blockFmt}
                    onChange={(v) => {
                      setBlockFmt(v);
                      exec("formatBlock", v);
                    }}
                    className="min-w-[6rem]"
                    options={[
                      { value: "p", label: tr("نص عادي") },
                      { value: "h1", label: tr("عنوان 1") },
                      { value: "h2", label: tr("عنوان 2") },
                      { value: "h3", label: tr("عنوان 3") },
                      { value: "pre", label: tr("كود") },
                    ]}
                  />
                  <ToolbarButton
                    title={tr("عريض (Ctrl+B)")}
                    active={fmtState.bold}
                    onMouseDown={() => exec("bold")}
                  >
                    <Bold className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title={tr("مائل (Ctrl+I)")}
                    active={fmtState.italic}
                    onMouseDown={() => exec("italic")}
                  >
                    <Italic className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title={tr("تسطير (Ctrl+U)")}
                    active={fmtState.underline}
                    onMouseDown={() => exec("underline")}
                  >
                    <Underline className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Colors */}
                  <label
                    title={tr("لون النص")}
                    className="relative inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <Palette className="h-3.5 w-3.5" />
                    <input
                      type="color"
                      onChange={(e) => applyForeColor(e.target.value)}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                  <label
                    title={tr("لون الخلفية")}
                    className="relative inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <Highlighter className="h-3.5 w-3.5" />
                    <input
                      type="color"
                      onChange={(e) => applyBackColor(e.target.value)}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                  {/* Alignment */}
                  <ToolbarButton
                    title={tr("محاذاة يمين")}
                    active={fmtState.justifyRight}
                    onMouseDown={() => alignEditorContent("right")}
                  >
                    <AlignRight className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title={tr("توسيط")}
                    active={fmtState.justifyCenter}
                    onMouseDown={() => alignEditorContent("center")}
                  >
                    <AlignCenter className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title={tr("محاذاة يسار")}
                    active={fmtState.justifyLeft}
                    onMouseDown={() => alignEditorContent("left")}
                  >
                    <AlignLeft className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Lists */}
                  <ToolbarButton
                    title={tr("قائمة نقطية")}
                    active={fmtState.insertUnorderedList}
                    onMouseDown={() => exec("insertUnorderedList")}
                  >
                    <List className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title={tr("قائمة مرقمة")}
                    active={fmtState.insertOrderedList}
                    onMouseDown={() => exec("insertOrderedList")}
                  >
                    <ListOrdered className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Link */}
                  <ToolbarButton title={tr("إدراج رابط")} onMouseDown={promptLink}>
                    <Link2 className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Undo / Redo */}
                  <ToolbarButton title={tr("تراجع (Ctrl+Z)")} onMouseDown={() => exec("undo")}>
                    <Undo2 className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton title={tr("إعادة (Ctrl+Y)")} onMouseDown={() => exec("redo")}>
                    <Redo2 className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {extensions.map((ext) => (
                    <button
                      key={ext.id}
                      type="button"
                      title={ext.title || ext.label}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        try {
                          ext.onClick(extensionContext);
                        } catch (err) {
                          console.error(`[composer-ext:${ext.id}]`, err);
                        }
                      }}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {ext.icon && <span aria-hidden>{ext.icon}</span>}
                      <span>{ext.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {plainMode ? (
                <textarea
                  defaultValue={stripHtml(editorRef.current?.innerHTML ?? initialHtml)}
                  onChange={(e) => {
                    if (editorRef.current) {
                      editorRef.current.innerHTML = plainToHtml(e.target.value);
                      notifyEditorChange();
                    }
                  }}
                  rows={16}
                  placeholder={tr("اكتب رسالتك هنا...")}
                  className="min-h-[320px] w-full resize-none bg-transparent px-4 py-3 text-sm outline-none"
                />
              ) : (
                <div ref={editorWrapRef} className="relative">
                  <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    aria-multiline="true"
                    aria-label={tr("نص الرسالة")}
                    data-placeholder={tr("اكتب رسالتك هنا...")}
                    className="composer-editor min-h-[320px] w-full whitespace-pre-wrap break-words px-4 py-3 text-sm outline-none"
                  />
                  {imgBox && (
                    <>
                      {/* Selection frame */}
                      <div
                        data-mm-image-tool="1"
                        className="pointer-events-none absolute rounded-sm ring-2 ring-primary/60"
                        style={{
                          top: imgBox.top,
                          left: imgBox.left,
                          width: imgBox.width,
                          height: imgBox.height,
                        }}
                      />
                      {/* Drag surface lives outside contentEditable and owns pointer capture. */}
                      <button
                        type="button"
                        data-mm-image-tool="1"
                        data-mm-image-drag-surface="1"
                        onPointerDown={startImageDrag}
                        title={tr("سحب الصورة")}
                        aria-label={tr("سحب الصورة")}
                        className="pointer-events-auto absolute z-[5] cursor-grab touch-none bg-transparent active:cursor-grabbing"
                        style={{
                          top: imgBox.top,
                          left: imgBox.left,
                          width: imgBox.width,
                          height: imgBox.height,
                        }}
                      />
                      {/* Email-safe alignment fallback. */}
                      <div
                        data-mm-image-tool="1"
                        className="pointer-events-auto absolute z-20 inline-flex overflow-hidden rounded-md border border-border bg-card shadow-md"
                        style={{ top: imgBox.top - 30, left: imgBox.left }}
                      >
                        {(
                          [
                            ["left", AlignLeft, tr("محاذاة الصورة لليسار")],
                            ["center", AlignCenter, tr("توسيط الصورة")],
                            ["right", AlignRight, tr("محاذاة الصورة لليمين")],
                          ] as const
                        ).map(([alignment, Icon, label]) => (
                          <button
                            key={alignment}
                            type="button"
                            data-mm-image-tool="1"
                            data-mm-image-align={alignment}
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              alignActiveImage(alignment);
                            }}
                            title={label}
                            aria-label={label}
                            className="pointer-events-auto inline-flex h-6 w-7 items-center justify-center text-muted-foreground transition hover:bg-accent hover:text-foreground"
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </button>
                        ))}
                      </div>
                      {/* Delete button (corner) */}
                      <button
                        type="button"
                        data-mm-image-tool="1"
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          deleteActiveImage();
                        }}
                        title={tr("حذف الصورة")}
                        aria-label={tr("حذف الصورة")}
                        className="pointer-events-auto absolute z-20 inline-flex h-6 w-6 items-center justify-center rounded-full bg-destructive text-white shadow-md transition hover:opacity-90"
                        style={{ top: imgBox.top - 8, left: imgBox.left + imgBox.width - 16 }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                      {/* Resize handle */}
                      <button
                        type="button"
                        data-mm-image-tool="1"
                        onPointerDown={startImageResize}
                        title={tr("تغيير حجم الصورة")}
                        aria-label={tr("تغيير حجم الصورة")}
                        className="pointer-events-auto absolute z-20 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-primary shadow-md"
                        style={{
                          top: imgBox.top + imgBox.height - 7,
                          left: imgBox.left + imgBox.width - 7,
                        }}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Attachments — existing (from loaded draft) + newly added files */}
          {(existingKept.length > 0 || files.length > 0) && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">
                {tr("المرفقات")} · {formatBytes(totalBytes)} / 25 MB
              </label>
              <div className="flex flex-wrap gap-2 rounded-lg border border-dashed border-border bg-background/50 p-3">
                {existingKept.map((a) => {
                  const { Icon, tint } = getAttachmentIcon(a.mimeType || "", a.filename);
                  return (
                    <div
                      key={`kept-${a.id}`}
                      className="group inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-soft"
                      title={tr("مرفق من المسودة الأصلية")}
                    >
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${tint}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="flex flex-col leading-tight">
                        <span className="max-w-[180px] truncate font-medium">{a.filename}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatBytes(a.size || 0)}
                        </span>
                      </div>
                      <button
                        onClick={() => removeExistingAttachment(a.id)}
                        disabled={sending}
                        className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                        aria-label={tr("حذف المرفق")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
                {files.map((f, i) => {
                  const { Icon, tint } = getAttachmentIcon(f.type, f.name);
                  const stage = uploadState.get(f);
                  return (
                    <div
                      key={`new-${f.name}-${i}`}
                      className="group inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-soft"
                    >
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${tint}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="flex flex-col leading-tight">
                        <span className="max-w-[180px] truncate font-medium">{f.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {stage?.status === "uploading"
                            ? `${formatBytes(f.size)} · ${stage.progress}%`
                            : stage?.status === "failed"
                              ? tr("فشل الرفع")
                              : formatBytes(f.size)}
                        </span>
                      </div>
                      <button
                        onClick={() => removeFile(i)}
                        disabled={sending}
                        className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                        aria-label={tr("حذف المرفق")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-surface/80 px-3 py-2.5 backdrop-blur sm:gap-3 sm:px-6 sm:py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSend}
            disabled={sending || to.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white shadow-brand transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
            title={tr("إرسال (Ctrl+Enter)")}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? tr("جاري الإرسال") : tr("إرسال")}
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(e) => void insertImageFiles(e.target.files)}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || normalAttachmentCount >= COMPOSE_MAX_NORMAL_ATTACHMENTS}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 sm:px-3"
            aria-label={tr("إرفاق ملف")}
            title={tr("إرفاق ملف")}
          >
            <Paperclip className="h-4 w-4" />
            <span className="hidden sm:inline">{tr("إرفاق")}</span>
          </button>
          <MailSignatureButton
            disabled={sending || signatureImagesLoading > 0}
            mailSessionToken={session.mailSessionToken ?? ""}
            onInsert={(html) => {
              const editor = editorRef.current;
              if (!editor) return;
              insertSignatureIntoEditor(editor, html);
              // Remote signature images remain URL-backed in the Draft HTML.
              // They must not be fetched/converted into local inline uploads:
              // that makes autosave depend on CORS/network and re-uploads the
              // image every session.
              notifyEditorChange();
            }}
          />
          <button
            type="button"
            onClick={() => void handleSaveAsDraft()}
            disabled={sending || deletingDraft}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 sm:px-3"
            aria-label={tr("حفظ كمسودة")}
            title={tr("حفظ كمسودة")}
          >
            <FileText className="h-4 w-4" />
            <span className="hidden sm:inline">{tr("حفظ كمسودة")}</span>
          </button>

          {shouldShowDeleteDraft(hasLocalDraft, hasRemoteDraft) && (
            <button
              type="button"
              onClick={() => void handleDeleteDraft()}
              disabled={sending || deletingDraft || saveStatus === "saving"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-background px-2.5 py-2 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-40 sm:px-3"
              aria-label={tr("حذف المسودة")}
              title={tr("حذف المسودة")}
            >
              {deletingDraft ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span>{tr(deletingDraft ? "جارٍ حذف المسودة" : "حذف المسودة")}</span>
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground sm:gap-3">
          <span className="sm:hidden">{savedLabel}</span>
          {(to.length > 0 || cc.length > 0 || bcc.length > 0) && (
            <span>{trf("عدد المستلمين", { count: to.length + cc.length + bcc.length })}</span>
          )}
          <button
            onClick={() => void requestClose()}
            className="rounded-lg border border-input bg-background px-3 py-2 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground"
          >
            {tr("إلغاء")}
          </button>
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/5 backdrop-blur-sm">
          <div className="rounded-lg border-2 border-dashed border-primary/60 bg-card px-6 py-3 text-sm font-medium shadow-float">
            {tr("أفلت الملفات هنا لإرفاقها")}
          </div>
        </div>
      )}

      <AlertDialog
        open={!!closePrompt}
        onOpenChange={(o) => {
          if (!o && closePrompt) {
            closePrompt.resolve("cancel");
            setClosePrompt(null);
          }
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-start">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div className="min-w-0 space-y-1.5">
                <AlertDialogTitle className="text-base">
                  {tr("الخروج بدون حفظ الرسالة؟")}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-sm leading-relaxed">
                  {tr("لديك رسالة غير محفوظة. يمكنك حفظها كمسودّة، أو حذفها، أو البقاء هنا.")}
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-start">
            <button
              type="button"
              onClick={() => {
                closePrompt?.resolve("save");
                setClosePrompt(null);
              }}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              <FileText className="h-4 w-4" />
              {tr("حفظ كمسودّة")}
            </button>
            <button
              type="button"
              onClick={() => {
                closePrompt?.resolve("discard");
                setClosePrompt(null);
              }}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-destructive/40 bg-background px-4 text-sm font-medium text-destructive transition hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              {tr("حذف")}
            </button>
            <button
              type="button"
              onClick={() => {
                closePrompt?.resolve("cancel");
                setClosePrompt(null);
              }}
              className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted sm:ms-auto"
            >
              {tr("البقاء هنا")}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- Attachment card with download + inline preview ----
const INLINE_PREVIEW_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function getAttachmentIcon(
  mimeType: string,
  filename: string,
): {
  Icon: typeof Paperclip;
  tint: string;
} {
  const mime = (mimeType || "").toLowerCase();
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (mime.startsWith("image/"))
    return { Icon: FileImage, tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
  if (mime.startsWith("video/"))
    return { Icon: FileVideo, tint: "bg-purple-500/10 text-purple-600 dark:text-purple-400" };
  if (mime.startsWith("audio/"))
    return { Icon: FileAudio, tint: "bg-pink-500/10 text-pink-600 dark:text-pink-400" };
  if (mime === "application/pdf" || ext === "pdf")
    return { Icon: FileType, tint: "bg-red-500/10 text-red-600 dark:text-red-400" };
  if (
    /zip|rar|7z|tar|gzip|compressed/.test(mime) ||
    ["zip", "rar", "7z", "tar", "gz"].includes(ext)
  )
    return { Icon: FileArchive, tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
  if (/sheet|excel|csv/.test(mime) || ["xls", "xlsx", "csv", "ods"].includes(ext))
    return { Icon: FileSpreadsheet, tint: "bg-green-500/10 text-green-600 dark:text-green-400" };
  if (/word|document|opendocument\.text/.test(mime) || ["doc", "docx", "odt", "rtf"].includes(ext))
    return { Icon: FileText, tint: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
  if (/presentation|powerpoint/.test(mime) || ["ppt", "pptx", "odp", "key"].includes(ext))
    return { Icon: FileType, tint: "bg-orange-500/10 text-orange-600 dark:text-orange-400" };
  if (
    /json|xml|javascript|typescript|html|css|x-sh|x-python/.test(mime) ||
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "json",
      "xml",
      "html",
      "css",
      "py",
      "sh",
      "java",
      "c",
      "cpp",
      "go",
      "rs",
    ].includes(ext)
  )
    return { Icon: FileCode, tint: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" };
  if (mime.startsWith("text/") || ["txt", "md", "log"].includes(ext))
    return { Icon: FileText, tint: "bg-slate-500/10 text-slate-600 dark:text-slate-400" };

  return { Icon: Paperclip, tint: "bg-brand-gradient/10 text-brand-accent" };
}

function AttachmentCard({
  attachment,
  message,
}: {
  attachment: import("@/lib/mail-types").MailAttachment;
  message: MailMessage;
}) {
  const [busy, setBusy] = useState<"download" | "preview" | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const canPreview = INLINE_PREVIEW_MIME.has((attachment.mimeType || "").toLowerCase());
  const canDownload = !!attachment.part;

  async function requestTransferUrl(mode: "download" | "preview"): Promise<string | null> {
    const session = getMailSession();
    if (!session) {
      toast.error(tr("انتهت الجلسة"));
      return null;
    }
    const parsed = parseMessageId(message.id);
    if (!parsed || !attachment.part) {
      toast.error(tr("لا يمكن تحديد المرفق"));
      return null;
    }
    const res = await fetch("/api/mail-attachment-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mailSessionToken: session.mailSessionToken ?? "",
        password: session.password,
        folder: parsed.folder,
        uid: parsed.uid,
        part: attachment.part,
        mode,
        filename: attachment.filename,
        mimeType: attachment.mimeType || "application/octet-stream",
        size: attachment.size || 0,
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      toast.error(tr("تعذّر تنزيل المرفق") + (msg ? `: ${msg.slice(0, 100)}` : ""));
      return null;
    }
    const result = await res.json().catch(() => null);
    return typeof result?.downloadUrl === "string" ? result.downloadUrl : null;
  }

  async function handleDownload() {
    if (busy || !canDownload) return;
    setBusy("download");
    try {
      const url = await requestTransferUrl("download");
      if (!url) return;
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setBusy(null);
    }
  }

  async function handlePreview() {
    if (busy || !canDownload || !canPreview) return;
    setBusy("preview");
    try {
      const url = await requestTransferUrl("preview");
      if (!url) return;
      setPreviewUrl(url);
    } finally {
      setBusy(null);
    }
  }

  const { Icon: FileIcon, tint } = getAttachmentIcon(attachment.mimeType, attachment.filename);

  return (
    <>
      <div className="group inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-soft">
        <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${tint}`}>
          <FileIcon className="h-3.5 w-3.5" />
        </span>
        <div className="flex flex-col leading-tight">
          <span className="max-w-[180px] truncate font-medium" title={attachment.filename}>
            {attachment.filename}
          </span>
          <span className="text-[10px] text-muted-foreground">
            <bdi dir="ltr">{formatSize(attachment.size)}</bdi>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {canPreview && (
            <button
              type="button"
              onClick={handlePreview}
              disabled={!canDownload || busy !== null}
              title={tr("معاينة")}
              aria-label={tr("معاينة")}
              className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "preview" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={!canDownload || busy !== null}
            title={canDownload ? tr("تنزيل") : tr("غير متاح")}
            aria-label={tr("تنزيل")}
            className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "download" ? (
              <CircleArrowDown className="h-3.5 w-3.5 animate-bounce text-primary" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-white">
            <p className="truncate text-sm font-medium">{attachment.filename}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20"
              >
                <Download className="h-3.5 w-3.5" /> {tr("تنزيل")}
              </button>
              <button
                type="button"
                onClick={() => setPreviewUrl(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/10 hover:bg-white/20"
                title={tr("إغلاق")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div
            className="flex flex-1 items-center justify-center overflow-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {attachment.mimeType.startsWith("image/") ? (
              <img
                src={previewUrl}
                alt={attachment.filename}
                className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
              />
            ) : (
              <iframe
                src={previewUrl}
                title={attachment.filename}
                className="h-full w-full rounded-lg bg-white shadow-2xl"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
