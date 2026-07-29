import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Virtuoso } from "react-virtuoso";
import DOMPurify from "dompurify";

// Strict allow-list sanitizer for inbound email HTML. DOMPurify's defaults
// already strip <script>, on*= handlers, and javascript: URLs; we harden a
// bit further by forbidding tags that can execute or exfiltrate (iframe,
// object, embed, form, link, meta, base, style) and by forcing external
// links to open in a new tab without leaking the referrer.
function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  // Allow <style> and inline style="..." so incoming emails keep their real
  // design (Gmail/GitHub/newsletters ship inline CSS + <style>). Isolation
  // and script safety are enforced by rendering inside a sandboxed <iframe>
  // via EmailBodyFrame — DOMPurify still strips script/iframe/on*= handlers
  // and javascript: URLs, so allowing style is safe here.
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta", "base"],
    FORBID_ATTR: ["srcdoc", "formaction"],
    ALLOW_DATA_ATTR: false,
  });
  // Best-effort target hardening — DOMPurify already blocks javascript: URLs.
  return clean.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer nofollow" ');
}

// Sanitizer for OUTGOING composer HTML — allows inline styles/fonts/colors
// (needed for email) but blocks scripts, event handlers, and dangerous tags.
function sanitizeComposerHtml(html: string): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta", "base", "style"],
    FORBID_ATTR: ["srcdoc", "formaction", "onerror", "onload", "onclick", "onmouseover", "onfocus"],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * EmailBodyFrame — renders sanitized email HTML inside a sandboxed iframe.
 *
 * Why: real-world emails ship inline CSS + <style> blocks (Gmail, GitHub,
 * newsletters). Rendering them directly in the app DOM either strips the
 * design (if we forbid style) or leaks the email's CSS into the app shell
 * (if we allow it). Gmail/Outlook/Roundcube all render inside an iframe —
 * we do the same.
 *
 * Safety: sandbox has NO allow-scripts, so JS in the body cannot run even
 * if it slipped past DOMPurify. Links open in a new top-level tab via
 * allow-popups-to-escape-sandbox + our target="_blank" rewrite.
 *
 * Performance: single iframe per open message, height set once after load
 * from body.scrollHeight — no polling, no ResizeObserver on the parent.
 */
function EmailBodyFrame({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(200);

  const srcDoc = useMemo(() => {
    const base = `
      <base target="_blank">
      <style>
        html,body{margin:0;padding:0;background:transparent;color:#111;
          font-family:'IBM Plex Sans Arabic',system-ui,-apple-system,Segoe UI,sans-serif;
          font-size:14px;line-height:1.6;word-wrap:break-word;overflow-wrap:anywhere;}
        img,video{max-width:100%;height:auto;border-radius:6px;}
        table{max-width:100%;}
        a{color:#2563eb;}
        blockquote{border-inline-start:3px solid #e5e7eb;margin:8px 0;padding:4px 12px;color:#4b5563;}
        pre,code{white-space:pre-wrap;word-break:break-word;}
      </style>`;
    return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${html}</body></html>`;
  }, [html]);

  const handleLoad = useCallback(() => {
    const iframe = ref.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      // Measure once. Use scrollHeight of documentElement/body max.
      const h = Math.max(
        doc.body.scrollHeight,
        doc.documentElement?.scrollHeight ?? 0,
      );
      if (h > 0) setHeight(h + 8);
    } catch {
      /* cross-origin should not happen with srcDoc; ignore */
    }
  }, []);

  return (
    <iframe
      ref={ref}
      title="email-body"
      srcDoc={srcDoc}
      onLoad={handleLoad}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      className={className}
      style={{ width: "100%", height, border: 0, display: "block" }}
    />
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
  ArrowLeft,
  RefreshCw,
  MoreVertical,
  MoreHorizontal,
  LogOut,
  Mail as MailIcon,
  Loader2,
  ChevronLeft,
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
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  bridgeGetMessage,
  bridgeMarkRead,
  bridgeStar,
  bridgeMove,
  bridgeDelete,
  bridgeSearch,
  bridgeSaveDraft,
  bridgeDeleteDraft,
} from "@/lib/mail-bridge.functions";
import {
  readDraftDoc,
  writeDraftDoc,
  updateDraftDocServerRef,
  clearDraftDoc,
  createDraftSaver,
  createPendingDeleteQueue,
  newDraftId,
  type DraftSaver,
  type DraftSaveStatus,
  type DraftServerRef,
  type DraftSnapshot,
  type DraftDocV3,
  type PendingDeleteQueue,
} from "@/lib/mail-draft-lifecycle";
import {
  createAutosaveScheduler,
  attachInputListener,
  attachBeforeUnloadGuard,
  isDraftEmpty,
} from "@/lib/mail-composer-autosave";
import { tombstoneGhostMessage } from "@/lib/mail-ghost-cleanup.functions";
import { indexListMessages } from "@/lib/mail-index.functions";
import { indexListFolderCounts } from "@/lib/mail-index-counts.functions";
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
import { clearMailSession, getMailSession, type MailSession } from "@/lib/mail-session";
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
  subject?: string;
  body?: string;
  /**
   * Edit-Draft mode: when set, the composer opens as an EDIT of an existing
   * server-side draft. draftId reuses the sticky X-MailMaestro-Draft-ID when
   * present (legacy drafts fall back to a fresh uuid + previousRef so the
   * bridge can atomically APPEND-then-delete the legacy copy — M4-A).
   */
  editDraftId?: string;
  previousRef?: DraftServerRef;
  existingAttachments?: EditDraftSource;
  /** When true, `body` is already sanitized HTML and is loaded verbatim. */
  bodyIsHtml?: boolean;
};

function stripHtml(html: string): string {
  if (!html) return "";
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "");
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function quoteBody(message: MailMessage): string {
  const src = stripHtml(message.body || message.preview || "");
  const dateStr = new Date(message.date).toLocaleString("ar", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const from = message.from.name
    ? `${message.from.name} <${message.from.email}>`
    : message.from.email;
  const header = `\n\n\nOn ${dateStr}, ${from} wrote:\n`;
  const quoted = src
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return header + quoted;
}

function buildReply(message: MailMessage, myEmail: string, all: boolean): ComposeInitial {
  const subject = message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`;
  const to = message.from.email;
  let cc = "";
  if (all) {
    const others = [
      ...message.to.map((a) => a.email),
      ...(message.cc?.map((a) => a.email) ?? []),
    ].filter(
      (e) => e && e.toLowerCase() !== myEmail.toLowerCase() && e.toLowerCase() !== to.toLowerCase(),
    );
    cc = Array.from(new Set(others)).join(", ");
  }
  return { to, cc, subject, body: quoteBody(message) };
}

function buildForward(message: MailMessage): ComposeInitial {
  const subject = message.subject.startsWith("Fwd:") ? message.subject : `Fwd: ${message.subject}`;
  const header =
    `\n\n---------- Forwarded message ----------\n` +
    `From: ${message.from.name} <${message.from.email}>\n` +
    `Date: ${new Date(message.date).toLocaleString("ar")}\n` +
    `Subject: ${message.subject}\n` +
    `To: ${message.to.map((t) => t.email).join(", ")}\n\n` +
    stripHtml(message.body || message.preview || "");
  return { to: "", subject, body: header };
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
  const rawSubject = message.subject === "(بدون موضوع)" ? "" : message.subject;
  const existingAttachments =
    message.attachments && message.attachments.length > 0
      ? { messageId: message.id, attachments: message.attachments }
      : undefined;
  return {
    to,
    cc,
    subject: rawSubject,
    body: message.body ?? "",
    bodyIsHtml: true,
    editDraftId,
    previousRef,
    existingAttachments,
  };
}

type SortOption = "date-desc" | "date-asc" | "unread-first" | "starred-first";

type SourceKind = "index" | "bridge" | "mock";

function useMailData(session: MailSession | null) {
  const getCounts = useServerFn(bridgeGetFolderCounts);
  const getMessages = useServerFn(bridgeGetMessages);
  const listIndex = useServerFn(indexListMessages);
  const listIndexCounts = useServerFn(indexListFolderCounts);
  const [folder, setFolder] = useState<MailFolder>("inbox");
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
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [useMock, setUseMock] = useState(false);
  const [source, setSource] = useState<SourceKind>("bridge");
  const [indexCursor, setIndexCursor] = useState<string | null>(null);
  // Per-folder "index ready" flag, used to drive the sync hook.
  const [indexReady, setIndexReady] = useState<Partial<Record<MailFolder, boolean>>>({});
  // Race guard: only accept a load result whose id matches the latest request.
  const loadReqIdRef = useRef(0);
  const PAGE = 50;

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

  const folderPath = folderPaths[folder] ?? null;

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
        // V4 count race guard: while a star mutation is in flight (or was
        // very recently), keep the optimistic starred.total instead of the
        // possibly-stale server value.
        if (isStarCountHot() && prev.starred) {
          map.starred = { ...map.starred, total: prev.starred.total };
        }
        return map;
      });
      setFolderPaths(paths);
      setBridgeError(null);
    } catch (err: any) {
      if (countsMutationGen.current !== gen) return;
      setBridgeError(err?.message || "فشل الاتصال بخادم البريد");
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
   * Manual-Refresh counts path: prefer Local Mail Index (single Supabase
   * SELECT, no IMAP round-trip). Falls back to the bridge only when the
   * index has not yet resolved for this account/session. Also refreshes
   * `folderPaths` from any bridge fallback path — the index never invents
   * new paths.
   */
  const loadCountsFast = useCallback(async () => {
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
          setCounts((prev) => {
            const next = { ...prev };
            for (const c of res.counts) {
              if (!c.hasUidvalidity) continue;
              // V4 count race guard: skip starred.total while a mutation is
              // hot; keep the optimistic value the toggle already applied.
              if (c.folder === "drafts") continue;
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
              next[c.folder] = { total: c.total, unread: c.unread, supported: cur.supported };
            }
            return next;
          });
          setFolderPaths((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const c of res.counts) {
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
            purgeStaleTrashUidValidity(safeOriginStorage(), currentAccountId, nextTrashUV, "trash");
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
          try {
            const authoritative = await getCounts({
              data: { mailSessionToken: session.mailSessionToken ?? "", password: session.password },
            });
            if (countsMutationGen.current !== gen) return;
            if (authoritative.ok) {
              const draftsCount = authoritative.counts.find((c) => c.folder === "drafts");
              if (draftsCount) {
                setCounts((prev) => ({
                  ...prev,
                  drafts: {
                    total: draftsCount.total,
                    unread: draftsCount.unread,
                    supported: draftsCount.supported !== false,
                  },
                }));
                if (draftsCount.path) {
                  setFolderPaths((prev) =>
                    prev.drafts === draftsCount.path ? prev : { ...prev, drafts: draftsCount.path },
                  );
                }
              }
            }
          } catch {
            /* keep previous Drafts count until bridge is reachable */
          }
          return;
        }
      } catch {
        /* fall through to bridge */
      }
    }
    await loadCounts();
  }, [session, listIndexCounts, loadCounts, isStarCountHot]);

  // Decide whether this (folder, sort, session) call can use the Local Mail Index.
  // Only "date-desc" is index-native; other sorts fall back to the bridge.
  const canUseIndex = useCallback(
    (f: MailFolder, s: SortOption) =>
      MAIL_INDEX_ENABLED &&
      s === "date-desc" &&
      !!session?.mailSessionToken &&
      !!folderPaths[f] &&
      // V4: "starred" is a virtual view over INBOX (\Flagged). The Local
      // Index has no distinct row for it, so serving it from the index
      // would either return zero rows or (worse) return every inbox row
      // regardless of the \Flagged flag. Always fall through to the Bridge.
      f !== "starred" &&
      // Drafts are mutated by high-frequency Bridge APPEND/delete cycles;
      // serving them from the async Local Index can show expunged UIDs,
      // duplicate rows, or stale counters. Bridge/IMAP remains authoritative.
      f !== "drafts",
    [session, folderPaths],
  );

  const loadFromBridge = useCallback(
    async (reqId: number) => {
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
        if (loadReqIdRef.current !== reqId) return;
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

        setMessages(applyPending(result.messages));
        setHasMore(result.messages.length >= PAGE);
        setBridgeError(null);
        setUseMock(false);
        setSource("bridge");
        setIndexCursor(null);
      } catch (err: any) {
        if (loadReqIdRef.current !== reqId) return;
        setBridgeError(err?.message || "تعذّر الاتصال بخادم البريد");
        setHasMore(false);
        setUseMock(false);
        setIndexCursor(null);
      }
    },
    [session, folder, sort, getMessages, applyPending, reconcilePendingMovesForRead],
  );

  const loadMessages = useCallback(async () => {
    if (!session) return;
    const reqId = ++loadReqIdRef.current;
    // Timestamp captured BEFORE the request is issued. After the load
    // succeeds we drop every "confirmed" hide whose confirmedAt <= this
    // value: any mutation that confirmed before this load started is
    // guaranteed to be reflected in the response.
    const startedAt = Date.now();
    setLoading(true);
    try {
      if (canUseIndex(folder, sort)) {
        try {
          const res = await listIndex({
            data: {
              mailSessionToken: session.mailSessionToken!,
              canonical: folder,
              limit: PAGE,
            },
          });
          if (loadReqIdRef.current !== reqId) return;
          if (res.ok && res.indexed) {
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
            gcHiddenBefore(pendingHiddenRef.current, startedAt);
            return;
          }
          // Not indexed yet OR transient error → mark not-ready and fall back.
          setIndexReady((prev) => (prev[folder] === false ? prev : { ...prev, [folder]: false }));
        } catch {
          setIndexReady((prev) => (prev[folder] === false ? prev : { ...prev, [folder]: false }));
        }
      }
      await loadFromBridge(reqId);
      if (loadReqIdRef.current === reqId) {
        gcHiddenBefore(pendingHiddenRef.current, startedAt);
      }
    } finally {
      if (loadReqIdRef.current === reqId) setLoading(false);
    }
  }, [session, folder, sort, canUseIndex, listIndex, loadFromBridge, applyPending]);

  const loadMore = useCallback(async () => {
    if (!session || loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    try {
      if (source === "index" && indexCursor && canUseIndex(folder, sort)) {
        const res = await listIndex({
          data: {
            mailSessionToken: session.mailSessionToken!,
            canonical: folder,
            limit: PAGE,
            cursor: indexCursor,
          },
        });
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
      setHasMore(false);
    } finally {
      setLoadingMore(false);
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
  ]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Reset to default sort whenever the folder changes (no persistence between refreshes).
  useEffect(() => {
    setSort("date-desc");
  }, [folder]);

  // Background Local Mail Index sync — initial when not ready, incremental
  // afterwards, plus a 5-minute reconcile once the folder is indexed.
  // Pauses when the tab is hidden and never overlaps itself.
  const isFolderIndexed = indexReady[folder] === true;
  const { reconcileNow, incrementalNow, shouldReconcile } = useMailIndexSync({
    session,
    folderPath,
    canonical: folder,
    indexed: isFolderIndexed,
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
      // Drafts are Bridge-authoritative to avoid ghosts during APPEND+delete.
      folder !== "drafts",
    onSynced: () => {
      // Background rounds only: refresh the current folder from the index
      // when the sync actually changed something (the hook already gates on
      // meaningful-change; suppressed rounds do NOT reach this callback).
      loadMessages();
      loadCountsFast();
    },
  });

  return {
    folder,
    setFolder,
    folderPaths,

    sort,
    setSort,
    counts,
    setCounts,
    messages,
    setMessages,
    loading,
    loadingMore,
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
    onAfterSend: async () => {
      // After a successful send: only refresh the Sent folder itself, and
      // only if the user is currently viewing it. From any other folder we
      // just pull counts once (Sent count moves; Inbox does not).
      if (folder === "sent") {
        await incrementalNow({ suppressOnSynced: true });
        await Promise.all([loadMessages(), loadCountsFast()]);
      } else {
        await loadCountsFast();
      }
    },
    onAfterDraftSaved: async () => {
      await loadCounts();
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
  const { confirm } = useConfirm();
  const [session, setSession] = useState<MailSession | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeInitial | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);
  const [reading, setReading] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectMode, setSelectMode] = useState(false);

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
  const [deepIncludeBody, setDeepIncludeBody] = useState(false);
  const [deepResults, setDeepResults] = useState<MailMessage[] | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);

  const {
    folder,
    setFolder,
    folderPaths,
    sort,

    setSort,
    counts,
    setCounts,
    messages,
    setMessages,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    bridgeError,
    useMock,
    loadCounts,
    refresh: rawRefresh,
    onAfterSend,
    onAfterDraftSaved,
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

  // BLOCKER_6 — account identity for origin-tracker calls in this scope.
  const currentAccountId = session?.account.id ?? null;

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

  const getOne = useServerFn(bridgeGetMessage);
  const cleanupGhost = useServerFn(tombstoneGhostMessage);

  const markRead = useServerFn(bridgeMarkRead);
  const star = useServerFn(bridgeStar);
  const updateFlag = useServerFn(indexUpdateFlag);
  const move = useServerFn(bridgeMove);
  const deleteFn = useServerFn(bridgeDelete);
  const moveIndex = useServerFn(indexMoveMessage);
  const deleteIndex = useServerFn(indexDeleteMessage);
  const searchFn = useServerFn(bridgeSearch);

  // Preferred path for \Seen / \Flagged mutations:
  //   session has mailSessionToken → indexUpdateFlag (IMAP + Local Index
  //   write-through in one round). Falls back to raw bridge for legacy
  //   sessions with no token. Throws on any failure so callers' optimistic
  //   rollback in .catch fires.
  const mutateFlag = useCallback(
    async (canonical: MailFolder, uid: number, kind: "seen" | "flagged", value: boolean) => {
      if (!session) throw new Error("لا توجد جلسة بريد");
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
      if (!session) throw new Error("لا توجد جلسة بريد");
      const dest = params.toFolder;
      // Permanent-delete branch — MUST use indexDeleteMessage (Blocker 1).
      if (dest === undefined) {
        if (params.sourceCanonical !== "trash") {
          throw new Error("الحذف النهائي مسموح فقط من مجلد المهملات");
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

  // In-memory caches for instant open (prefetch on hover)
  const messageCache = useRef<Map<string, MailMessage>>(new Map());
  const inflight = useRef<Map<string, Promise<MailMessage | null>>>(new Map());

  const fetchMessage = useCallback(
    (id: string): Promise<MailMessage | null> => {
      if (!session) return Promise.resolve(null);
      // Batch A / Fix #2: check the pending-move overlay BEFORE reading
      // cache. A source row the user just moved must not be resurrected
      // from a warm cache entry that was stored before the mutation.
      // Destination rows resolve to a different physical folder — they are
      // NOT suppressed by design (see isMessageSuppressed).
      const accountId = currentAccountId;
      if (accountId && isMessageSuppressed(pendingMovesRef.current, accountId, id)) {
        return Promise.resolve(null);
      }
      const cached = messageCache.current.get(id);
      if (cached) return Promise.resolve(cached);
      const existing = inflight.current.get(id);
      if (existing) return existing;
      const parsed = parseMessageId(id);
      if (!parsed) return Promise.resolve(null);
      const p = getOne({
        data: {
          mailSessionToken: session.mailSessionToken ?? "",
          password: session.password,
          folder: parsed.folder,
          uid: parsed.uid,
        },
      })
        .then((result) => {
          if (result.ok && result.message) {
            // Batch A / Fix #2: re-check the overlay AFTER the fetch. The
            // user may have moved this row during the round-trip; writing
            // it into messageCache would let it re-appear.
            const acc = currentAccountId;
            if (acc && isMessageSuppressed(pendingMovesRef.current, acc, id)) {
              return null;
            }
            // Patch through pending overrides so a slow fetch response cannot
            // overwrite an in-flight optimistic star/read the user just set.
            const patched = applyPendingOne(result.message);
            messageCache.current.set(id, patched);
            return patched;
          }
          // Ghost cleanup: only on proven-absent (NOT_FOUND). Fire the
          // server-side tombstone (idempotent), then evict the local row
          // so the list and message view stop pointing at nothing.
          if (!result.ok && result.code === "NOT_FOUND") {
            if (parsed.folder !== "all") {
              void cleanupGhost({
                data: {
                  mailSessionToken: session.mailSessionToken ?? "",
                  canonical: parsed.folder,
                  uid: parsed.uid,
                },
              }).catch(() => {});
            }
            messageCache.current.delete(id);
            setMessages((prev) => prev.filter((m) => m.id !== id));
            hideRow(id);
            setSelectedId((cur) => (cur === id ? null : cur));
            setSelectedMessage((cur) => (cur && cur.id === id ? null : cur));
            toast.info("تم إزالة رسالة مفقودة من القائمة");
            return null;
          }

          return null;
        })
        .catch(() => null)
        .finally(() => {
          inflight.current.delete(id);
        });
      inflight.current.set(id, p);
      return p;
    },
    [session, getOne, applyPendingOne, currentAccountId, cleanupGhost],
  );

  const prefetchMessage = useCallback(
    (id: string) => {
      // Batch A / Fix #2: never trigger a prefetch for a row already
      // suppressed by the pending-move overlay.
      const accountId = currentAccountId;
      if (accountId && isMessageSuppressed(pendingMovesRef.current, accountId, id)) return;
      if (!messageCache.current.has(id) && !inflight.current.has(id)) {
        void fetchMessage(id);
      }
    },
    [fetchMessage, currentAccountId],
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

  // Clear message cache when switching folders (memory hygiene)
  useEffect(() => {
    messageCache.current.clear();
    inflight.current.clear();
    setSelection(new Set());
    setSelectMode(false);
  }, [folder]);

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
          setDeepError(res.error || "فشل البحث على السيرفر");
        }
      } catch (err: any) {
        if (!cancelled) {
          setDeepResults([]);
          setDeepError(err?.message || "فشل البحث على السيرفر");
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

  const filteredMessages = useMemo(() => {
    // Deep server-side search: always show server results (even empty).
    if (searchMode === "deep" && query.trim().length >= 2) {
      return deepResults ?? [];
    }
    if (!query.trim()) return messages;
    const q = query.toLowerCase();
    return messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.name.toLowerCase().includes(q) ||
        m.from.email.toLowerCase().includes(q) ||
        m.preview.toLowerCase().includes(q),
    );
  }, [messages, query, searchMode, deepResults]);
  const inDeepSearch = searchMode === "deep" && query.trim().length >= 2;

  async function openMessage(id: string) {
    if (!(await guardComposerNav())) return;
    setSelectedId(id);
    const parsed = parseMessageId(id);
    if (!parsed || !session) {
      setSelectedMessage(getMockMessage(id) ?? null);
      return;
    }
    const cached = messageCache.current.get(id);
    if (cached) {
      // Instant open (0ms perceived latency)
      setSelectedMessage(cached);
      setReading(false);
    } else {
      setSelectedMessage(null);
      setReading(true);
    }
    try {
      const msg = await fetchMessage(id);
      if (msg) setSelectedMessage(msg);
      else if (!cached) throw new Error("فشل فتح الرسالة");

      // M4-C: Drafts folder → open the message directly inside the composer
      // as an Edit-Draft (server-side draft is the source of truth). We
      // intentionally do this AFTER the fetch so the composer receives full
      // recipients / body / attachments metadata rather than list-preview.
      const loaded = msg ?? cached ?? null;
      if (loaded && parsed.folder === "drafts") {
        const draftsPath = folderPaths.drafts ?? undefined;
        setCompose(buildEditDraft(loaded, draftsPath));
        setSelectedId(null);
        setSelectedMessage(null);
        setReading(false);
        return;
      }

      const listMsg = messages.find((m) => m.id === id);
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
    } catch (err: any) {
      if (!cached) {
        toast.error(err?.message || "فشل فتح الرسالة");
        setSelectedMessage(getMockMessage(id) ?? null);
      }
    } finally {
      setReading(false);
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
    } catch (err: any) {
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
      toast.error(err?.message || "فشل تحديث المميّز");
    } finally {
      // V4: always release the star-count "hot" window, success or failure.
      endStarMutation();
    }
  }

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
    } catch (err: any) {
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
      toast.error(err?.message || "فشل تحديث حالة القراءة");
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
        toast.success("تم نقل الرسالة");
      } catch (err: any) {
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
        toast.error(err?.message || "فشل نقل الرسالة");
      }
    });
  }

  async function handleDelete(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    const isTrash = parsed.folder === "trash";
    const confirmed = await confirm({
      title: isTrash ? "حذف نهائي" : "نقل إلى المهملات",
      description: isTrash
        ? "هل أنت متأكد من حذف هذه الرسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء."
        : "هل أنت متأكد من نقل هذه الرسالة إلى المهملات؟",
      confirmLabel: isTrash ? "حذف" : "نقل",
      cancelLabel: "إلغاء",
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
        toast.success(isTrash ? "تم حذف الرسالة نهائياً" : "تم نقل الرسالة إلى المهملات");
      } catch (err: any) {
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
        toast.error(err?.message || (isTrash ? "فشل حذف الرسالة" : "فشل نقل الرسالة إلى المهملات"));
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
        toast.success(`تم استعادة الرسالة إلى ${label}`);
      } catch (err: any) {
        unhideRow(id);
        rollbackPendingMove(id);
        applyMoveCountsDelta(target, parsed.folder, wasUnread); // revert
        if (original) reviveMessageAt(original, originalIndex);
        if (cachedBody) messageCache.current.set(id, cachedBody);
        if (wasSelected) {
          setSelectedId(id);
          if (prevSelected) setSelectedMessage(prevSelected);
        }
        toast.error(err?.message || "فشل استعادة الرسالة");
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
    } catch (err: any) {
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
      toast.error(err?.message || "فشل التعليم كغير مقروءة");
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
  async function runBatch<T>(items: T[], limit: number, worker: (item: T) => Promise<any>) {
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
      toast.error(`فشل نقل ${failedIds.length} من ${ids.length} رسالة`);
    } else {
      toast.success(`تم نقل ${ids.length} رسالة`);
    }
  }

  async function bulkDelete() {
    if (!session || selection.size === 0 || bulkBusy) return;
    const ids = Array.from(selection);
    const isTrash = folder === "trash";
    const confirmed = await confirm({
      title: isTrash ? "حذف نهائي" : "نقل إلى المهملات",
      description: isTrash
        ? `هل أنت متأكد من حذف ${ids.length} رسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`
        : `هل أنت متأكد من نقل ${ids.length} رسالة إلى المهملات؟`,
      confirmLabel: isTrash ? "حذف" : "نقل",
      cancelLabel: "إلغاء",
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
    const cachedBodies = new Map<string, any>();
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
          ? `فشل حذف ${failedIds.length} من ${ids.length} رسالة`
          : `فشل نقل ${failedIds.length} من ${ids.length} رسالة إلى المهملات`,
      );
    } else {
      toast.success(
        isTrash ? `تم حذف ${ids.length} رسالة` : `تم نقل ${ids.length} رسالة إلى المهملات`,
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
      toast.error(`فشل استعادة ${failedIds.length} من ${ids.length} رسالة`);
    } else {
      toast.success(`تم استعادة ${ids.length} رسالة`);
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
    if (failed > 0) toast.error(`فشل تعليم ${failed} رسالة`);
    else toast.success(`تم تعليم ${ids.length} رسالة كغير مقروءة`);
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
          <span>تعذّر الاتصال بخادم البريد. سنعيد المحاولة تلقائياً.</span>
          <button
            onClick={() => rawRefresh()}
            className="underline underline-offset-2 hover:opacity-80"
          >
            إعادة المحاولة الآن
          </button>
        </div>
      )}

      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4">
        <button
          onClick={() => setSidebarOpen((s) => !s)}
          className="rounded-lg p-2 hover:bg-muted lg:hidden"
          aria-label="القائمة"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link to="/mail" className="flex shrink-0 items-center gap-2">
          {session.company?.logo_url ? (
            <img
              src={session.company.logo_url}
              alt={brandName}
              className="h-8 w-8 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient text-white">
              <MailIcon className="h-4 w-4" />
            </div>
          )}
          <span className="hidden text-base font-bold sm:inline">{brandName}</span>
        </Link>

        <div className="mx-2 flex flex-1 items-center gap-1 rounded-xl bg-muted/70 pe-1 ps-3 py-1.5 transition focus-within:bg-card focus-within:shadow-elevated sm:mx-4 sm:max-w-xl">
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
            placeholder={searchMode === "deep" ? "بحث شامل على السيرفر…" : "ابحث في البريد..."}
            className="w-full bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="مسح"
              aria-label="مسح"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <DropdownMenu dir="rtl">
            <DropdownMenuTrigger asChild>
              <button
                className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                  searchMode === "deep"
                    ? "bg-primary/10 text-primary hover:bg-primary/15"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                title="خيارات البحث"
              >
                {searchMode === "deep" ? (
                  <Globe className="h-3.5 w-3.5" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">{searchMode === "deep" ? "شامل" : "سريع"}</span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
                نمط البحث
              </div>
              <DropdownMenuItem
                onSelect={() => setSearchMode("quick")}
                className="flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">بحث سريع</span>
                    {searchMode === "quick" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    فوري في الرسائل المعروضة — دون أي طلب للسيرفر
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
                    <span className="font-medium">بحث شامل على السيرفر</span>
                    {searchMode === "deep" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    IMAP SEARCH على كامل المجلد الحالي (الموضوع + المرسل + المستلمين)
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
                    <span className="font-medium">تضمين نص الرسالة</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    أبطأ لكنه يبحث داخل محتوى الرسائل أيضاً
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <div
            className="hidden max-w-[200px] truncate rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground md:inline-block"
            dir="ltr"
            title={session.account.email_address}
          >
            {session.account.email_address}
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-70 sm:inline-flex"
            title="تحديث البريد"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
            <span className="hidden lg:inline">{refreshing ? "جاري التحديث..." : "تحديث"}</span>
          </button>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="rounded-lg p-2 hover:bg-muted disabled:opacity-70 sm:hidden"
            aria-label="تحديث"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
          </button>
          <button
            onClick={handleSignOut}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:inline-flex"
            title="تسجيل الخروج"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden lg:inline">خروج</span>
          </button>
          <button
            onClick={handleSignOut}
            className="rounded-lg p-2 hover:bg-muted sm:hidden"
            aria-label="خروج"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 right-0 top-14 z-30 w-64 shrink-0 transform border-l border-border bg-sidebar transition-transform lg:relative lg:top-0 lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0" : "translate-x-full lg:translate-x-0"
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
              رسالة جديدة
            </button>
          </div>

          <nav className="px-2">
            {(Object.keys(FOLDER_META) as MailFolder[])
              .filter((f) => counts[f]?.supported !== false)
              .map((f) => {
                const meta = FOLDER_META[f];
                const active = f === folder;
                const Icon = meta.icon;
                const { total } = counts[f] || { total: 0 };
                return (
                  <button
                    key={f}
                    onClick={async () => {
                      if (!(await guardComposerNav())) return;
                      setFolder(f);
                      setSelectedId(null);
                      setSelectedMessage(null);
                      setSidebarOpen(false);
                    }}
                    className={`mb-0.5 flex w-full items-center gap-3 rounded-r-full rounded-l-md px-4 py-2.5 text-sm transition ${
                      active
                        ? "bg-sidebar-hover font-semibold text-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-hover/60"
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${active ? "text-primary" : ""}`} />
                    <span className="flex-1 text-right">{meta.label}</span>
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
          </nav>
        </aside>

        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 top-14 z-20 bg-black/40 lg:hidden"
          />
        )}

        {/* Message list */}
        <div
          className={`flex w-full flex-col border-l border-border bg-card md:w-96 md:shrink-0 ${
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
                    ? "إلغاء التحديد"
                    : "تحديد الكل"
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
                {selection.size > 0 ? `${selection.size} محددة` : "اختر الرسائل"}
              </span>
              <div className="flex-1" />
              {bulkBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {selection.size > 0 && (
                <DropdownMenu dir="rtl">
                  <DropdownMenuTrigger asChild>
                    <button
                      disabled={bulkBusy}
                      className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                      title="إجراءات"
                    >
                      <MoreVertical className="h-4 w-4" />
                      <span>إجراءات</span>
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
                          استعادة المحدد
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
                      أرشفة المحدد
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => bulkMove("spam")}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <AlertOctagon className="ms-2 h-4 w-4" />
                      نقل إلى المزعج
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={bulkMarkUnread}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <MailIcon className="ms-2 h-4 w-4" />
                      تعليم كغير مقروءة
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={bulkDelete}
                      disabled={bulkBusy}
                      className="cursor-pointer text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:text-destructive"
                    >
                      <Trash2 className="ms-2 h-4 w-4" />
                      {folder === "trash" ? "حذف نهائياً" : "نقل إلى المهملات"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <button
                onClick={toggleSelectMode}
                disabled={bulkBusy}
                className="rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                title="إلغاء التحديد"
              >
                إلغاء
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
                    title="تحديد الكل"
                  >
                    <Square className="h-5 w-5 text-muted-foreground" />
                  </button>
                )}
                <span className="font-semibold text-muted-foreground">
                  {inDeepSearch ? (
                    <span className="flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5 text-primary" />
                      <span>
                        نتائج السيرفر · {filteredMessages.length}
                        {deepIncludeBody && (
                          <span className="ms-1 text-[10px] text-primary/70">(يشمل المحتوى)</span>
                        )}
                      </span>
                    </span>
                  ) : (
                    <>المعروضة · {filteredMessages.length}</>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <button
                  onClick={toggleSelectMode}
                  className={`rounded px-2 py-1.5 text-xs font-medium transition ${
                    selectMode
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "text-foreground hover:bg-muted"
                  }`}
                >
                  {selectMode ? "إلغاء" : "تحديد"}
                </button>
                {!inDeepSearch && (
                  <DropdownMenu dir="rtl">
                    <DropdownMenuTrigger asChild>
                      <button
                        className="flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                        title="ترتيب العرض"
                      >
                        <ArrowUpDown className="h-3.5 w-3.5" />
                        <span>ترتيب</span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {(
                        [
                          { value: "date-desc", label: "الأحدث أولاً" },
                          { value: "date-asc", label: "الأقدم أولاً" },
                          { value: "unread-first", label: "غير المقروءة أولاً" },
                          { value: "starred-first", label: "المميّزة بنجمة أولاً" },
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
            {(loading || (inDeepSearch && deepLoading)) && filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                {inDeepSearch && (
                  <p className="text-xs text-muted-foreground">جاري البحث على السيرفر…</p>
                )}
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MailIcon className="h-10 w-10 opacity-30" />
                {inDeepSearch ? (
                  <>
                    <p className="text-sm">{deepError ? deepError : "لا توجد نتائج على السيرفر"}</p>
                    {!deepError && !deepIncludeBody && (
                      <p className="text-[11px] text-muted-foreground/70">
                        جرّب تفعيل «تضمين نص الرسالة» من خيارات البحث
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm">لا توجد رسائل هنا</p>
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
                  if (!query.trim() && !inDeepSearch) void loadMore();
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
                    onPrefetch={() => prefetchMessage(m.id)}
                    onToggleStar={(e) => toggleStar(e, m.id)}
                    onToggleRead={(e) => toggleRead(e, m.id)}
                    onToggleSelect={() => toggleSelect(m.id)}
                  />
                )}
                components={{
                  Footer: () =>
                    loadingMore ? (
                      <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> جاري تحميل المزيد…
                      </div>
                    ) : !hasMore && filteredMessages.length > 0 ? (
                      <div className="py-4 text-center text-[11px] text-muted-foreground">
                        — نهاية الرسائل —
                      </div>
                    ) : null,
                }}
              />
            )}
          </div>
        </div>

        {/* Message viewer */}
        <div
          className={`flex-1 overflow-hidden bg-surface ${
            compose || selectedMessage || (selectedId && reading) ? "flex" : "hidden md:flex"
          } flex-col`}
        >
          {compose ? (
            <Composer
              session={session}
              initial={compose}
              onClose={() => setCompose(null)}
              onSent={onAfterSend}
              onDraftSaved={onAfterDraftSaved}
            />
          ) : selectedMessage ? (
            <MessageView
              message={selectedMessage}
              loading={reading}
              myEmail={session.account.email_address}
              onBack={() => {
                setSelectedId(null);
                setSelectedMessage(null);
              }}
              onReply={() =>
                setCompose(buildReply(selectedMessage, session.account.email_address, false))
              }
              onReplyAll={() =>
                setCompose(buildReply(selectedMessage, session.account.email_address, true))
              }
              onForward={() => setCompose(buildForward(selectedMessage))}
              onArchive={() => handleMove(selectedMessage.id, "archive")}
              onDelete={() => handleDelete(selectedMessage.id)}
              onSpam={() => handleMove(selectedMessage.id, "spam")}
              onMarkUnread={() => handleMarkUnread(selectedMessage.id)}
              onRestore={() => handleRestore(selectedMessage.id)}
              onPrint={() => {
                /* handled inside MessageView */
              }}
            />
          ) : selectedId && reading ? (
            <LoadingViewer
              onBack={() => {
                setSelectedId(null);
                setSelectedMessage(null);
              }}
            />
          ) : (
            <EmptyViewer />
          )}
        </div>
      </div>
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
  onPrefetch,
  onToggleStar,
  onToggleRead,
  onToggleSelect,
}: {
  message: MailMessage;
  active: boolean;
  selected: boolean;
  anySelected: boolean;
  selectMode: boolean;
  onClick: () => void;
  onPrefetch?: () => void;
  onToggleStar: (e: React.MouseEvent) => void;
  onToggleRead: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onTouchStart={onPrefetch}
      className={`group flex w-full cursor-pointer items-start gap-3 border-b border-border/60 px-4 py-3 text-right transition-colors duration-150 hover:bg-muted/50 active:bg-muted active:duration-75 ${
        active ? "bg-accent" : ""
      } ${selected ? "bg-primary/5" : ""} ${!message.read ? "bg-card" : "bg-card/70"}`}
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
          title={selected ? "إلغاء التحديد" : "تحديد"}
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
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatDate(message.date)}
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
            title={message.starred ? "إزالة المميّز" : "تمييز"}
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
            title={message.read ? "تعليم كغير مقروءة" : "تعليم كمقروءة"}
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
        </div>
      </div>
    </div>
  );
}

function MessageView({
  message,
  loading,
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
}: {
  message: MailMessage;
  loading: boolean;
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
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const recipientsAll = [
    ...message.to.map((t) => ({ ...t, kind: "to" as const })),
    ...(message.cc || []).map((c) => ({ ...c, kind: "cc" as const })),
  ];
  const toSummary = recipientsAll.length > 0 ? recipientsAll.map((r) => r.email).join("، ") : "—";

  const fullDate = new Date(message.date).toLocaleString("ar", {
    dateStyle: "full",
    timeStyle: "short",
  });
  const isTrash = message.folder === "trash";
  const canRestore = message.folder === "trash" || message.folder === "archive";
  const canArchive = message.folder !== "archive" && message.folder !== "trash";

  const isSecure = !!message.security && !/غير/.test(message.security);

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(message.from.email);
      toast.success("تم نسخ البريد");
    } catch {
      toast.error("تعذّر النسخ");
    }
  }

  function printMessage() {
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) {
      toast.error("تعذّر فتح نافذة الطباعة");
      return;
    }
    const esc = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
      );
    const subject = esc(message.subject || "(بدون موضوع)");
    const fromName = esc(message.from.name || message.from.email);
    const fromEmail = esc(message.from.email);
    const to = esc(message.to.map((t) => t.email).join(", "));
    const cc =
      message.cc && message.cc.length > 0 ? esc(message.cc.map((c) => c.email).join(", ")) : "";
    const date = esc(new Date(message.date).toLocaleString("ar"));
    const body = message.body ? sanitizeEmailHtml(message.body) : esc(message.preview);
    win.document
      .write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${subject}</title>
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
  <div><strong>المرسل:</strong> ${fromName} &lt;${fromEmail}&gt;</div>
  <div><strong>المستلم:</strong> <span dir="ltr">${to}</span></div>
  ${cc ? `<div><strong>نسخة:</strong> <span dir="ltr">${cc}</span></div>` : ""}
  <div><strong>التاريخ:</strong> ${date}</div>
</div>
<div class="body">${body}</div>
<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
</body></html>`);
    win.document.close();
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
          aria-label="رجوع"
        >
          <ChevronLeft className="h-4 w-4" /> رجوع
        </button>
        <div className="hidden gap-1 md:flex">
          <button onClick={onReply} className="rounded-lg p-2 hover:bg-muted" title="رد">
            <Reply className="h-4 w-4" />
          </button>
          <button
            onClick={onReplyAll}
            className="rounded-lg p-2 hover:bg-muted"
            title="رد على الكل"
          >
            <ReplyAll className="h-4 w-4" />
          </button>
          <button onClick={onForward} className="rounded-lg p-2 hover:bg-muted" title="إعادة توجيه">
            <Forward className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          {canRestore && (
            <button
              onClick={onRestore}
              className="rounded-lg p-2 hover:bg-muted"
              title="استعادة إلى المجلد الأصلي"
            >
              <ArchiveRestore className="h-4 w-4" />
            </button>
          )}

          {canArchive && (
            <button onClick={onArchive} className="rounded-lg p-2 hover:bg-muted" title="أرشفة">
              <Archive className="h-4 w-4" />
            </button>
          )}
          <button onClick={onSpam} className="rounded-lg p-2 hover:bg-muted" title="مزعج">
            <AlertOctagon className="h-4 w-4" />
          </button>
          <button
            onClick={onMarkUnread}
            className="rounded-lg p-2 hover:bg-muted"
            title="تعليم كغير مقروءة"
          >
            <MailOpen className="h-4 w-4" />
          </button>
          <button onClick={printMessage} className="rounded-lg p-2 hover:bg-muted" title="طباعة">
            <Printer className="h-4 w-4" />
          </button>
          <button
            onClick={copyEmail}
            className="rounded-lg p-2 hover:bg-muted"
            title="نسخ عنوان المرسل"
          >
            <Copy className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          <button
            onClick={onDelete}
            className="rounded-lg p-2 text-destructive hover:bg-destructive/10"
            title={isTrash ? "حذف نهائي" : "نقل إلى المهملات"}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded-lg p-2 hover:bg-muted" aria-label="خيارات أكثر">
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="w-56 [direction:rtl] [&_[role=menuitem]]:flex-row [&_[role=menuitem]]:justify-start [&_[role=menuitem]]:text-right"
          >
            <DropdownMenuItem onClick={onReply}>
              <Reply className="h-4 w-4" /> رد
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReplyAll}>
              <ReplyAll className="h-4 w-4" /> رد على الكل
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onForward}>
              <Forward className="h-4 w-4" /> إعادة توجيه
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onMarkUnread}>
              <MailOpen className="h-4 w-4" /> تعليم كغير مقروءة
            </DropdownMenuItem>
            <DropdownMenuItem onClick={printMessage}>
              <Printer className="h-4 w-4" /> طباعة
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyEmail}>
              <Copy className="h-4 w-4" /> نسخ عنوان المرسل
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {canRestore && (
              <DropdownMenuItem onClick={onRestore}>
                <ArchiveRestore className="h-4 w-4" /> استعادة إلى المجلد الأصلي
              </DropdownMenuItem>
            )}

            {canArchive && (
              <DropdownMenuItem onClick={onArchive} className="md:hidden">
                <Archive className="h-4 w-4" /> أرشفة
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onSpam} className="md:hidden">
              <AlertOctagon className="h-4 w-4" /> مزعج
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> {isTrash ? "حذف نهائي" : "نقل إلى المهملات"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl p-4 sm:p-6">
            <h1 className="break-words text-xl font-bold leading-snug sm:text-2xl">
              {message.subject || "(بدون موضوع)"}
            </h1>

            <div className="mt-4 flex items-start gap-3 border-b border-border pb-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
                {(message.from.name || message.from.email || "?").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold leading-tight">
                      {message.from.name || message.from.email || "(مرسل غير معروف)"}
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
                    className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                    title={new Date(message.date).toLocaleString("ar")}
                  >
                    {formatDate(message.date)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setDetailsOpen((v) => !v)}
                    aria-expanded={detailsOpen}
                    className="inline-flex max-w-full items-center gap-1 rounded hover:text-foreground"
                    title="تفاصيل الرسالة"
                  >
                    <span className="truncate">
                      <span className="text-foreground/70">إلى </span>
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
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1.5 text-xs">
                        <dt className="text-foreground/70 whitespace-nowrap">المرسل:</dt>
                        <dd className="min-w-0 break-all">
                          {message.from.name ? (
                            <span className="ml-1">{message.from.name}</span>
                          ) : null}
                          <span dir="ltr" className="text-muted-foreground">
                            &lt;{message.from.email || "—"}&gt;
                          </span>
                        </dd>

                        <dt className="text-foreground/70 whitespace-nowrap">المستلم:</dt>
                        <dd className="min-w-0 break-all">
                          <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                            {message.to.length > 0
                              ? message.to.map((t) => t.email).join(", ")
                              : "—"}
                          </span>
                        </dd>

                        {message.cc && message.cc.length > 0 && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">نسخة:</dt>
                            <dd className="min-w-0 break-all">
                              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                                {message.cc.map((c) => c.email).join(", ")}
                              </span>
                            </dd>
                          </>
                        )}

                        <dt className="text-foreground/70 whitespace-nowrap">التاريخ:</dt>
                        <dd className="min-w-0">{fullDate}</dd>

                        {message.mailedBy && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">الخادم:</dt>
                            <dd className="min-w-0 break-all">
                              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                                {message.mailedBy}
                              </span>
                            </dd>
                          </>
                        )}
                        {message.signedBy && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">التوقيع:</dt>
                            <dd className="min-w-0 break-all">
                              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                                {message.signedBy}
                              </span>
                            </dd>
                          </>
                        )}
                        {message.security && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">الأمان:</dt>
                            <dd className="min-w-0 inline-flex items-center gap-1">
                              {isSecure ? (
                                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                              ) : (
                                <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                              )}
                              <span>{message.security}</span>
                            </dd>
                          </>
                        )}
                      </dl>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <EmailBodyFrame
              html={sanitizeEmailHtml(message.body || message.preview || "")}
              className="mt-6"
            />


            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-6">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">
                  المرفقات ({message.attachments.length})
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {message.attachments.map((a) => (
                    <AttachmentCard key={a.id} attachment={a} message={message} />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={onReply}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Reply className="h-4 w-4" /> رد
              </button>
              <button
                onClick={onReplyAll}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <ReplyAll className="h-4 w-4" /> رد على الكل
              </button>
              <button
                onClick={onForward}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Forward className="h-4 w-4" /> إعادة توجيه
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function EmptyViewer() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
      <MailIcon className="h-16 w-16 opacity-30" />
      <p className="text-sm">اختر رسالة من القائمة لعرضها</p>
    </div>
  );
}

function LoadingViewer({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
          aria-label="رجوع"
        >
          <ChevronLeft className="h-4 w-4" /> رجوع
        </button>
        <div />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    </>
  );
}

const COMPOSE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const COMPOSE_MAX_FILES = 10;

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
                title={r.valid ? r.email : "بريد غير صالح"}
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
                  aria-label={`إزالة ${r.email}`}
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
                    title="إزالة من الاقتراحات"
                    aria-label="إزالة من الاقتراحات"
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
        className="peer h-7 w-full cursor-pointer appearance-none rounded-md border border-input bg-background ps-2 pe-6 text-xs text-foreground outline-none hover:bg-muted focus:ring-2 focus:ring-ring/40"
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
      <ChevronDown className="pointer-events-none absolute end-1.5 h-3 w-3 text-muted-foreground" />
    </div>
  );
}

function Composer({
  session,
  initial,
  onClose,
  onSent,
  onDraftSaved,
}: {
  session: MailSession;
  initial?: ComposeInitial | null;
  onClose: () => void;
  onSent: () => void;
  onDraftSaved: () => void;
}) {
  // Draft storage keying is owned by mail-draft-lifecycle (v3 + auto-migration).

  // ----- Address book (contact suggestions) — local IDB, hydrated once -----
  const hydrateSuggestions = useServerFn(hydrateContactSuggestions);
  const recordSuggestions = useServerFn(recordSentRecipients);
  const hideSuggestion = useServerFn(hideContactSuggestion);
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
  // M4-C: when opening in Edit-Draft mode we IGNORE any local v3 doc — the
  // server-side draft is the source of truth. We also key the composer to the
  // sticky draftId so a fresh mount cleanly re-hydrates from the server ref.
  const isEditMode = Boolean(initial?.editDraftId);
  const initialDoc = useMemo<DraftDocV3 | null>(() => {
    if (isEditMode) return null;
    if (initial && (initial.to || initial.cc || initial.subject || initial.body)) return null;
    if (typeof window === "undefined") return null;
    return readDraftDoc(window.localStorage, accountEmail);
  }, [initial, accountEmail, isEditMode]);
  const restored = initialDoc?.snapshot ?? null;

  const [draftId] = useState<string>(
    () => initial?.editDraftId ?? initialDoc?.draftId ?? newDraftId(),
  );
  const [serverRef, setServerRef] = useState<DraftServerRef | null>(
    () => initial?.previousRef ?? initialDoc?.serverRef ?? null,
  );
  const [saveStatus, setSaveStatus] = useState<DraftSaveStatus>(() =>
    isEditMode ? "saved" : initialDoc ? "saved-local" : "idle",
  );
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
  const [bcc, setBcc] = useState<Recipient[]>(() => restored?.bcc ?? []);
  const [showCc, setShowCc] = useState<boolean>(
    () => restored?.showCc ?? parseRecipientText(initial?.cc ?? "").length > 0,
  );
  const [showBcc, setShowBcc] = useState<boolean>(() => restored?.showBcc ?? false);
  const [subject, setSubject] = useState<string>(() => restored?.subject ?? initial?.subject ?? "");
  const initialHtml = useMemo(() => {
    if (restored?.html) return restored.html;
    if (initial?.bodyIsHtml && initial.body) return initial.body;
    if (initial?.body) return plainToHtml(initial.body);
    return "";
  }, [restored, initial]);

  // M4-C: existing server-side attachments carried over from the loaded
  // Drafts message. Each entry stays as metadata until first save/send, at
  // which point we lazily stream its bytes from the bridge (server proxy,
  // never base64 in JSON) and cache the resulting File.
  const [existingKept, setExistingKept] = useState<import("@/lib/mail-types").MailAttachment[]>(
    () => initial?.existingAttachments?.attachments ?? [],
  );
  const existingSourceIdRef = useRef<string | null>(
    initial?.existingAttachments?.messageId ?? null,
  );
  const existingFilesCacheRef = useRef<Map<string, File>>(new Map());

  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  // Composer runs inline inside the message-viewer pane (Superhuman-style).
  const [dragging, setDragging] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(() => initialDoc?.updatedAt ?? null);

  // ----- Dirty tracking + guarded close -----
  // Generation-based dirty: `generation` bumps on every user edit (body input
  // or structural field change). `savedGeneration` only advances when the
  // saver reports a completion for THAT generation via `onCompleted`. A
  // stale response never marks newer content clean.
  const generationRef = useRef<number>(0);
  const savedGenerationRef = useRef<number>(0);
  const isDirtyRef = useRef<boolean>(false);
  // Kept for the header "تم الحفظ منذ …" UI only — not the dirty source of truth.
  const lastSavedAtRef = useRef<number>(initialDoc?.updatedAt ?? 0);
  // Diagnostic: last hard-failure code from the saver (null on success).
  const lastFailCodeRef = useRef<string | null>(null);
  const recomputeDirty = () => {
    isDirtyRef.current = generationRef.current > savedGenerationRef.current;
  };
  const markEdited = () => {
    generationRef.current += 1;
    recomputeDirty();
  };
  // bodyRev mirrors generation for the autosave effect dependency (React
  // needs a value in deps; contentEditable does not trigger re-renders).
  const [bodyRev, setBodyRev] = useState(0);
  const [closePrompt, setClosePrompt] = useState<{
    resolve: (choice: "save" | "discard" | "cancel") => void;
  } | null>(null);

  // ----- Server-side draft saver (bridge APPEND) + pending-delete queue -----
  const bridgeSaveDraftFn = useServerFn(bridgeSaveDraft);
  const bridgeDeleteDraftFn = useServerFn(bridgeDeleteDraft);

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
  const resolveExistingAsFilesRef = useRef<() => Promise<File[] | null>>(async () => []);

  const saverRef = useRef<DraftSaver | null>(null);
  const draftRefreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (draftRefreshTimerRef.current !== null) {
        window.clearTimeout(draftRefreshTimerRef.current);
        draftRefreshTimerRef.current = null;
      }
    };
  }, []);

  const scheduleDraftRefresh = useCallback(() => {
    if (typeof window === "undefined") return;
    if (draftRefreshTimerRef.current !== null) window.clearTimeout(draftRefreshTimerRef.current);
    draftRefreshTimerRef.current = window.setTimeout(() => {
      draftRefreshTimerRef.current = null;
      void onDraftSaved();
    }, 650);
  }, [onDraftSaved]);

  if (!saverRef.current) {
    saverRef.current = createDraftSaver(draftId, {
      saveRemote: async ({ snapshot, previousRef }) => {
        const token = session.mailSessionToken;
        if (!token) return { ok: false, code: "SESSION_REQUIRED" };
        // M4-C: every save must carry the CURRENT attachment set so the
        // bridge's APPEND-then-delete cycle preserves both kept legacy
        // attachments and newly added files. A failed download aborts the
        // save rather than silently producing an attachment-less draft.
        let keptFiles: File[] = [];
        try {
          const resolved = await resolveExistingAsFilesRef.current();
          if (resolved === null) return { ok: false, code: "NETWORK" };
          keptFiles = resolved;
        } catch {
          return { ok: false, code: "NETWORK" };
        }
        const currentFiles = filesRef.current;
        const form = new FormData();
        const payload = {
          mailSessionToken: token,
          draftId,
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
          bodyHtml: snapshot.html,
          bodyText: stripHtml(snapshot.html),
          previousRef: previousRef ?? undefined,
        };
        form.append("payload", JSON.stringify(payload));
        for (const f of keptFiles) form.append("attachments", f, f.name);
        for (const f of currentFiles) form.append("attachments", f, f.name);
        try {
          const res = await bridgeSaveDraftFn({ data: form });
          if (res?.ok) {
            if (typeof res.uid === "number" && res.uid > 0 && res.uidValidity && res.folderPath) {
              return {
                ok: true,
                serverRef: {
                  folderPath: res.folderPath,
                  uid: res.uid,
                  uidValidity: res.uidValidity,
                },
              };
            }
            return { ok: true };
          }
          return { ok: false, code: res?.code };
        } catch {
          return { ok: false, code: "NETWORK" };
        }
      },
      onStatus: setSaveStatus,
      onServerRef: (r) => setServerRef(r),
      onCompleted: ({ completedGeneration, status, serverRef, code }) => {
        // Advance the clean marker ONLY when a save actually persisted
        // (remote success, or local-fallback on NETWORK). A hard failure
        // (SESSION_REQUIRED, APPEND_FAILED, etc.) MUST leave the composer
        // dirty so the user can retry or refuse to close.
        if (status === "saved" || status === "saved-local") {
          if (completedGeneration > savedGenerationRef.current) {
            savedGenerationRef.current = completedGeneration;
            recomputeDirty();
          }
          lastSavedAtRef.current = Date.now();
          setSavedAt(lastSavedAtRef.current);
          lastFailCodeRef.current = null;
          if (status === "saved" && serverRef && typeof window !== "undefined") {
            serverRefRef.current = serverRef;
            updateDraftDocServerRef(window.localStorage, accountEmail, draftId, serverRef);
            scheduleDraftRefresh();
          }
        } else if (status === "failed") {
          // Diagnostic: capture the coarse code so the UI can surface it
          // (helps distinguish APPEND_FAILED / SAFE_DRAFT_REPLACE_UNSUPPORTED
          // / SESSION_REQUIRED / IMAP_ERROR / UNKNOWN without leaking PII).
          lastFailCodeRef.current = code ?? "UNKNOWN";
          // Also log to the browser console for support triage. No PII.
          try {
            console.error("[draft-save] failed code=", lastFailCodeRef.current);
          } catch {
            /* noop */
          }
        }
        // status === "failed" → no savedGeneration advance, no savedAt bump.
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
  const editorRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Set initial editor HTML once
  useEffect(() => {
    if (editorRef.current && initialHtml && editorRef.current.innerHTML === "") {
      editorRef.current.innerHTML = initialHtml;
    }
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

  const existingBytes = existingKept.reduce((acc, a) => acc + (a.size || 0), 0);
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0) + existingBytes;
  const totalCount = files.length + existingKept.length;

  // Ref mirror so the (persistent) saveRemote closure created at first mount
  // always reads the latest kept-attachment list without being torn down.
  const existingKeptRef = useRef(existingKept);
  useEffect(() => {
    existingKeptRef.current = existingKept;
  }, [existingKept]);

  /**
   * Lazily fetch every kept existing attachment as a File, streaming bytes
   * from the bridge via the authenticated proxy (never base64 in JSON). All
   * downloads are cached per-composer-session so autosaves are cheap after
   * the first save. Returns `null` when any attachment fails so the caller
   * can abort — we never silently drop a kept attachment.
   */
  async function resolveExistingAsFiles(): Promise<File[] | null> {
    const kept = existingKeptRef.current;
    if (kept.length === 0) return [];
    const sourceId = existingSourceIdRef.current;
    if (!sourceId) return null;
    const parsed = parseMessageId(sourceId);
    if (!parsed) return null;
    const cache = existingFilesCacheRef.current;
    const out: File[] = [];
    for (const att of kept) {
      const cached = cache.get(att.id);
      if (cached) {
        out.push(cached);
        continue;
      }
      if (!att.part) return null;
      const res = await fetch("/api/mail-attachment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailSessionToken: session.mailSessionToken ?? "",
          password: session.password,
          folder: parsed.folder,
          uid: parsed.uid,
          part: att.part,
        }),
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      const file = new File([blob], att.filename || "attachment", {
        type: att.mimeType || blob.type || "application/octet-stream",
      });
      cache.set(att.id, file);
      out.push(file);
    }
    return out;
  }

  // Publish the latest values to the persistent saveRemote closure refs.
  filesRef.current = files;
  resolveExistingAsFilesRef.current = resolveExistingAsFiles;

  // ----- Draft autosave (scheduled): local write first, then remote APPEND -----
  // Persistent, disposable scheduler + input/beforeunload guards. All three
  // helpers expose idempotent .dispose() and are torn down inside useEffect
  // cleanup so no callback runs after unmount.
  const autosaveRef = useRef<ReturnType<typeof createAutosaveScheduler> | null>(null);
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
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const scheduler = createAutosaveScheduler({
      delayMs: 800,
      onFire: () => {
        const s = snapshotInputsRef.current;
        if (s.sending) return;
        const html = editorRef.current?.innerHTML ?? "";
        const isEmpty = isDraftEmpty({
          toCount: s.to.length,
          ccCount: s.cc.length,
          bccCount: s.bcc.length,
          subject: s.subject,
          htmlTrimmed: html.trim(),
          existingKeptCount: s.existingKeptLen,
          filesCount: s.filesLen,
        });
        if (isEmpty) {
          clearDraftDoc(window.localStorage, s.accountEmail);
          setSavedAt(null);
          setSaveStatus("idle");
          // Empty draft = nothing to persist; treat current gen as saved.
          savedGenerationRef.current = generationRef.current;
          recomputeDirty();
          return;
        }
        const snapshot: DraftSnapshot = {
          to: s.to,
          cc: s.cc,
          bcc: s.bcc,
          subject: s.subject,
          html,
          showCc: s.showCc,
          showBcc: s.showBcc,
        };
        const persisted = writeDraftDoc(window.localStorage, s.accountEmail, {
          version: 3,
          draftId,
          snapshot,
          serverRef: serverRefRef.current,
          updatedAt: Date.now(),
        });
        if (!persisted) {
          setSaveStatus("failed");
          return;
        }
        // Capture generation at schedule-fire time and pass it into the
        // saver. `savedGeneration` will only advance when onCompleted echoes
        // this exact value (or a newer coalesced one) — a stale response
        // can never mark newer content clean.
        const genAtFire = generationRef.current;
        void saverRef.current?.requestSave(snapshot, serverRefRef.current, genAtFire);
      },
    });
    autosaveRef.current = scheduler;
    return () => {
      scheduler.dispose();
      autosaveRef.current = null;
    };
  }, [draftId]);

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
    markEdited();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, showCc, showBcc, existingKept, files]);

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
  async function requestClose(): Promise<boolean> {
    if (closeFlowRef.current) return closeFlowRef.current;
    const flow = (async (): Promise<boolean> => {
      if (!isDirtyRef.current) {
        onClose();
        return true;
      }
      const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
        setClosePrompt({ resolve });
      });
      if (choice === "cancel") {
        // Release the single-flight so the user can try again.
        return false;
      }
      if (choice === "save") {
        const result = await saveDraftNow();
        // saved_server + saved_local(NETWORK) → composer becomes clean and
        // we may close. failed / empty (unexpected here since we were dirty)
        // → keep composer open so nothing is silently lost.
        if (result === "saved_server" || result === "saved_local") {
          onClose();
          return true;
        }
        return false;
      }
      // discard
      try {
        if (typeof window !== "undefined") {
          clearDraftDoc(window.localStorage, accountEmail);
        }
        // Best-effort server delete when a server ref exists; on failure hand
        // the delete to the pending queue for the next composer session.
        const ref = serverRefRef.current;
        if (ref) {
          const token = session.mailSessionToken;
          if (token) {
            bridgeDeleteDraftFn({
              data: { mailSessionToken: token, draftId, previousRef: ref },
            })
              .then((res) => {
                if (!res?.ok) {
                  pendingQueueRef.current?.enqueue(accountEmail, {
                    draftId,
                    previousRef: ref,
                  });
                }
              })
              .catch(() => {
                pendingQueueRef.current?.enqueue(accountEmail, {
                  draftId,
                  previousRef: ref,
                });
              });
          } else {
            pendingQueueRef.current?.enqueue(accountEmail, { draftId, previousRef: ref });
          }
        }
      } catch {
        /* noop */
      }
      // Force clean so beforeunload/guard don't re-trap on the way out.
      savedGenerationRef.current = generationRef.current;
      lastSavedAtRef.current = Date.now();
      recomputeDirty();
      onClose();
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
    onClose();
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
    let runningTotal = totalBytes;
    let runningCount = totalCount;
    for (const f of incoming) {
      if (runningCount >= COMPOSE_MAX_FILES) {
        toast.error(`الحد الأقصى ${COMPOSE_MAX_FILES} ملفات`);
        break;
      }
      if (runningTotal + f.size > COMPOSE_MAX_TOTAL_BYTES) {
        toast.error(`تجاوزت الحد الكلّي (25MB)`);
        break;
      }
      merged.push(f);
      runningTotal += f.size;
      runningCount += 1;
    }
    setFiles(merged);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeExistingAttachment(id: string) {
    setExistingKept((prev) => prev.filter((a) => a.id !== id));
    existingFilesCacheRef.current.delete(id);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function exec(command: string, value?: string) {
    if (typeof document === "undefined") return;
    editorRef.current?.focus();
    try {
      document.execCommand(command, false, value);
    } catch {
      /* noop */
    }
    // execCommand doesn't always fire selectionchange (esp. for alignment);
    // force toolbar state refresh.
    try {
      document.dispatchEvent(new Event("selectionchange"));
    } catch {
      /* noop */
    }
  }

  function promptLink() {
    const url = window.prompt("رابط URL (يبدأ بـ https://):", "https://");
    if (!url) return;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) {
        toast.error("رابط غير مدعوم");
        return;
      }
      exec("createLink", u.toString());
    } catch {
      toast.error("رابط غير صالح");
    }
  }

  function insertHtmlAtCursor(html: string) {
    editorRef.current?.focus();
    try {
      document.execCommand("insertHTML", false, html);
    } catch {
      /* noop */
    }
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
    try {
      span.appendChild(range.extractContents());
      range.insertNode(span);
      // Restore selection over the new span
      const newRange = document.createRange();
      newRange.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(newRange);
    } catch {
      /* noop */
    }
  }
  function applyForeColor(color: string) {
    exec("foreColor", color);
  }
  function applyBackColor(color: string) {
    // hiliteColor works in Firefox/Chrome; backColor as fallback
    editorRef.current?.focus();
    try {
      if (!document.execCommand("hiliteColor", false, color)) {
        document.execCommand("backColor", false, color);
      }
    } catch {
      /* noop */
    }
  }
  function setEditorDirection(dir: "rtl" | "ltr") {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    root.dir = dir;
    root.style.textAlign = dir === "rtl" ? "right" : "left";
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
    blocks.forEach((el) => {
      el.setAttribute("dir", dir);
      el.style.textAlign = dir === "rtl" ? "right" : "left";
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
    const url = window.prompt("رابط الصورة (https://):", "https://");
    if (!url) return;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) {
        toast.error("رابط صورة غير مدعوم");
        return;
      }
      insertHtmlAtCursor(`<img src="${u.toString()}" alt="" style="max-width:100%;height:auto" />`);
    } catch {
      toast.error("رابط غير صالح");
    }
  }

  const extensionContext = {
    getHtml: () => editorRef.current?.innerHTML ?? "",
    setHtml: (h: string) => {
      if (editorRef.current) editorRef.current.innerHTML = h;
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
    setSending(true);
    setProgress(0);
    try {
      const bodyHtml = sanitizeComposerHtml(editorRef.current?.innerHTML ?? "");
      const bodyText = stripHtml(bodyHtml);

      const payload = {
        mailSessionToken: session.mailSessionToken ?? "",
        password: session.password,
        to: to.filter((r) => r.valid).map((r) => ({ name: r.name ?? "", email: r.email })),
        cc: cc.filter((r) => r.valid).map((r) => ({ name: r.name ?? "", email: r.email })),
        bcc: bcc.filter((r) => r.valid).map((r) => ({ name: r.name ?? "", email: r.email })),
        subject,
        bodyHtml,
        bodyText,
      };

      // M4-C: preserve kept legacy/server attachments alongside newly added
      // files. If any kept attachment can't be streamed we ABORT rather than
      // silently sending a message with missing attachments.
      let keptFiles: File[] = [];
      try {
        const resolved = await resolveExistingAsFiles();
        if (resolved === null) {
          toast.error("تعذّر تحميل مرفق من المسودة الأصلية");
          return;
        }
        keptFiles = resolved;
      } catch {
        toast.error("تعذّر تحميل مرفق من المسودة الأصلية");
        return;
      }

      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      for (const f of keptFiles) form.append("attachments", f, f.name);
      for (const f of files) form.append("attachments", f, f.name);

      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/mail-send");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          try {
            const json = JSON.parse(xhr.responseText || "{}");
            if (xhr.status >= 200 && xhr.status < 300 && json.ok) resolve({ ok: true });
            else resolve({ ok: false, error: json.error || `HTTP ${xhr.status}` });
          } catch {
            resolve({ ok: false, error: `HTTP ${xhr.status}` });
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(form);
      });

      if (!result.ok) {
        toast.error(result.error || "فشل إرسال الرسالة");
        return;
      }
      // Clear draft on successful send: local wipe + best-effort server delete,
      // with any failure re-queued so the next composer mount can retry it.
      try {
        clearDraftDoc(window.localStorage, accountEmail);
      } catch {
        /* noop */
      }
      const refAtSend = serverRefRef.current;
      const hadServerCopy = !!refAtSend || saveStatus !== "idle";
      if (hadServerCopy) {
        const token = session.mailSessionToken ?? "";
        let deleteOk = false;
        try {
          const del = await bridgeDeleteDraftFn({
            data: {
              mailSessionToken: token,
              draftId,
              previousRef: refAtSend ?? undefined,
            },
          });
          deleteOk = !!del?.ok;
        } catch {
          deleteOk = false;
        }
        if (!deleteOk) {
          pendingQueueRef.current?.enqueue(accountEmail, {
            draftId,
            previousRef: refAtSend,
          });
        }
      }
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
      toast.success("تم إرسال الرسالة");
      onClose();
      onSent();
    } catch (err: any) {
      toast.error(err?.message || "فشل إرسال الرسالة");
    } finally {
      setSending(false);
      setProgress(0);
    }
  }

  async function handleSend() {
    if (to.length === 0) {
      toast.error("أضف مستلماً واحداً على الأقل");
      return;
    }
    const invalid = [...to, ...cc, ...bcc].filter((r) => !r.valid);
    if (invalid.length > 0) {
      toast.error(`عنوان بريد غير صالح: ${invalid[0].email}`);
      return;
    }
    if (!subject.trim()) {
      const ok = window.confirm("لا يوجد موضوع. هل ترغب في الإرسال على أي حال؟");
      if (!ok) return;
    }
    // Attachment-mention detector
    const html = editorRef.current?.innerHTML ?? "";
    const text = stripHtml(html).toLowerCase();
    const mentionsAttach = /(attach|attached|attachment|مرفق|مرفقات|المرفق)/.test(text);
    if (mentionsAttach && files.length === 0) {
      const ok = window.confirm("ذكرت مرفقاً لكن لم تُضِف أي ملف. هل تريد الإرسال دون مرفق؟");
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
  }, [to, cc, bcc, subject, files]);

  // Inline mode: composer fills the message-viewer pane on the same
  // light bg-surface used elsewhere, wrapped in an elegant card.
  const containerClass = "relative flex h-full w-full flex-col bg-surface";

  const savedLabel = (() => {
    const t = savedAt
      ? new Date(savedAt).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })
      : "";
    switch (saveStatus) {
      case "saving":
        return "جارٍ الحفظ…";
      case "saved":
        return t ? `تم الحفظ ${t}` : "تم الحفظ";
      case "saved-local":
        return t ? `محفوظة محلياً ${t}` : "محفوظة محلياً";
      case "failed":
        return "تعذّر الحفظ";
      default:
        return "";
    }
  })();

  // Prevents double-submit of manual saves (rapid Ctrl+S / button clicks).
  const savingNowRef = useRef(false);
  type SaveNowResult = "saved_server" | "saved_local" | "failed" | "empty";
  async function saveDraftNow(): Promise<SaveNowResult> {
    if (typeof window === "undefined") return "failed";
    if (savingNowRef.current) {
      // Double-submit protection: reflect current effective state.
      const st = saverRef.current?.getStatus();
      if (st === "saved") return "saved_server";
      if (st === "saved-local") return "saved_local";
      if (st === "failed") return "failed";
      return "saved_server";
    }
    savingNowRef.current = true;
    try {
      // Any pending debounced save must NOT race the explicit save.
      autosaveRef.current?.cancel();
      const html = sanitizeComposerHtml(editorRef.current?.innerHTML ?? "");
      // Unified emptiness contract with autosave: a draft that carries
      // attachments (new OR kept legacy) is NOT empty even without text.
      const isEmpty = isDraftEmpty({
        toCount: to.length,
        ccCount: cc.length,
        bccCount: bcc.length,
        subject,
        htmlTrimmed: html.trim(),
        existingKeptCount: existingKeptRef.current.length,
        filesCount: filesRef.current.length,
      });
      if (isEmpty) {
        toast.info("لا يوجد محتوى للحفظ");
        return "empty";
      }
      const snapshot: DraftSnapshot = { to, cc, bcc, subject, html, showCc, showBcc };
      const persisted = writeDraftDoc(window.localStorage, accountEmail, {
        version: 3,
        draftId,
        snapshot,
        serverRef: serverRefRef.current,
        updatedAt: Date.now(),
      });
      if (!persisted) {
        setSaveStatus("failed");
        toast.error("تعذّر حفظ المسودّة");
        return "failed";
      }
      const genAtRequest = generationRef.current;
      await saverRef.current?.requestSave(snapshot, serverRefRef.current, genAtRequest);
      const st = saverRef.current?.getStatus();
      if (st === "saved") {
        toast.success("تم حفظ المسودّة");
        return "saved_server";
      }
      if (st === "saved-local") {
        toast.success("تم حفظ المسودّة محلياً");
        return "saved_local";
      }
      // Hard failure — do NOT show a "success" toast.
      toast.error(
        `تعذّر حفظ المسودّة على الخادم — حاول لاحقاً (${lastFailCodeRef.current ?? "UNKNOWN"})`,
      );
      return "failed";
    } finally {
      savingNowRef.current = false;
    }
  }

  return (
    <div
      ref={containerRef}
      className={containerClass}
      role="dialog"
      aria-label="إنشاء رسالة"
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
      {/* Header — flush with the pane, on the same surface */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-surface/80 px-3 py-2.5 backdrop-blur sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-brand sm:h-9 sm:w-9">
            <Send className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {subject || "رسالة جديدة"}
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
            title="إغلاق (Esc)"
            aria-label="إغلاق"
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
            label="المرسل له"
            value={to}
            onChange={setTo}
            autoFocus
            getSuggestions={suggestFor}
            onHideSuggestion={hideOne}
            rightSlot={
              <div className="flex shrink-0 flex-wrap items-center gap-1 sm:border-r sm:border-border/60 sm:pr-2 sm:mr-2">
                {!showCc && (
                  <button
                    type="button"
                    onClick={() => setShowCc(true)}
                    className="inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-primary"
                  >
                    نسخة إلى
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    onClick={() => setShowBcc(true)}
                    className="inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-primary"
                  >
                    نسخة مخفية إلى
                  </button>
                )}
              </div>
            }
          />
          {showCc && (
            <RecipientField
              label="نسخة إلى"
              value={cc}
              onChange={setCc}
              getSuggestions={suggestFor}
              onHideSuggestion={hideOne}
            />
          )}
          {showBcc && (
            <RecipientField
              label="نسخة مخفية إلى"
              value={bcc}
              onChange={setBcc}
              getSuggestions={suggestFor}
              onHideSuggestion={hideOne}
            />
          )}

          {/* Subject */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">الموضوع</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="اكتب موضوع الرسالة"
              className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* Editor */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium text-foreground">نص الرسالة</label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title={plainMode ? "الوضع المنسّق" : "الوضع النصّي"}
                  onClick={() => setPlainMode((v) => !v)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Type className="h-3.5 w-3.5" />
                </button>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      title="خيارات متقدمة"
                      aria-label="خيارات متقدمة"
                      onMouseDown={(e) => e.preventDefault()}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                      <span>متقدم</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto p-2">
                    <div className="grid grid-cols-6 gap-0.5">
                      <ToolbarButton
                        title="يتوسطه خط"
                        active={fmtState.strikeThrough}
                        onMouseDown={() => exec("strikeThrough")}
                      >
                        <Strikethrough className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title="مرتفع"
                        active={fmtState.superscript}
                        onMouseDown={() => exec("superscript")}
                      >
                        <Superscript className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title="منخفض"
                        active={fmtState.subscript}
                        onMouseDown={() => exec("subscript")}
                      >
                        <Subscript className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title="ضبط"
                        active={fmtState.justifyFull}
                        onMouseDown={() => exec("justifyFull")}
                      >
                        <AlignJustify className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title="زيادة المسافة البادئة"
                        onMouseDown={() => exec("indent")}
                      >
                        <Indent className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title="تقليل المسافة البادئة"
                        onMouseDown={() => exec("outdent")}
                      >
                        <Outdent className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title="اقتباس"
                        active={fmtState.blockquote}
                        onMouseDown={() => exec("formatBlock", "blockquote")}
                      >
                        <Quote className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton title="إدراج صورة" onMouseDown={promptImage}>
                        <ImageIcon className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton title="خط أفقي" onMouseDown={insertHR}>
                        <Minus className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton
                        title="تبديل اتجاه النص RTL/LTR"
                        onMouseDown={toggleEditorDirection}
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                      </ToolbarButton>
                      <ToolbarButton title="إزالة التنسيق" onMouseDown={() => exec("removeFormat")}>
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
                    title="الخط"
                    ariaLabel="الخط"
                    placeholder="الخط"
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
                    title="حجم الخط"
                    ariaLabel="حجم الخط"
                    placeholder="الحجم"
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
                    title="نمط الفقرة"
                    ariaLabel="نمط الفقرة"
                    placeholder="الفقرة"
                    value={blockFmt}
                    onChange={(v) => {
                      setBlockFmt(v);
                      exec("formatBlock", v);
                    }}
                    className="min-w-[6rem]"
                    options={[
                      { value: "p", label: "نص عادي" },
                      { value: "h1", label: "عنوان 1" },
                      { value: "h2", label: "عنوان 2" },
                      { value: "h3", label: "عنوان 3" },
                      { value: "pre", label: "كود" },
                    ]}
                  />
                  <ToolbarButton
                    title="عريض (Ctrl+B)"
                    active={fmtState.bold}
                    onMouseDown={() => exec("bold")}
                  >
                    <Bold className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title="مائل (Ctrl+I)"
                    active={fmtState.italic}
                    onMouseDown={() => exec("italic")}
                  >
                    <Italic className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title="تسطير (Ctrl+U)"
                    active={fmtState.underline}
                    onMouseDown={() => exec("underline")}
                  >
                    <Underline className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Colors */}
                  <label
                    title="لون النص"
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
                    title="لون الخلفية"
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
                    title="محاذاة يمين"
                    active={fmtState.justifyRight}
                    onMouseDown={() => exec("justifyRight")}
                  >
                    <AlignRight className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title="توسيط"
                    active={fmtState.justifyCenter}
                    onMouseDown={() => exec("justifyCenter")}
                  >
                    <AlignCenter className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title="محاذاة يسار"
                    active={fmtState.justifyLeft}
                    onMouseDown={() => exec("justifyLeft")}
                  >
                    <AlignLeft className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Lists */}
                  <ToolbarButton
                    title="قائمة نقطية"
                    active={fmtState.insertUnorderedList}
                    onMouseDown={() => exec("insertUnorderedList")}
                  >
                    <List className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title="قائمة مرقمة"
                    active={fmtState.insertOrderedList}
                    onMouseDown={() => exec("insertOrderedList")}
                  >
                    <ListOrdered className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Link */}
                  <ToolbarButton title="إدراج رابط" onMouseDown={promptLink}>
                    <Link2 className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {/* Undo / Redo */}
                  <ToolbarButton title="تراجع (Ctrl+Z)" onMouseDown={() => exec("undo")}>
                    <Undo2 className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  <ToolbarButton title="إعادة (Ctrl+Y)" onMouseDown={() => exec("redo")}>
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
                    }
                  }}
                  rows={16}
                  placeholder="اكتب رسالتك هنا..."
                  className="min-h-[320px] w-full resize-none bg-transparent px-4 py-3 text-sm outline-none"
                />
              ) : (
                <div
                  ref={editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-label="نص الرسالة"
                  data-placeholder="اكتب رسالتك هنا..."
                  className="composer-editor min-h-[320px] w-full whitespace-pre-wrap break-words px-4 py-3 text-sm outline-none"
                />
              )}
            </div>
          </div>

          {/* Attachments — existing (from loaded draft) + newly added files */}
          {(existingKept.length > 0 || files.length > 0) && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">
                المرفقات · {formatBytes(totalBytes)} / 25 MB
              </label>
              <div className="flex flex-wrap gap-2 rounded-lg border border-dashed border-border bg-background/50 p-3">
                {existingKept.map((a) => {
                  const { Icon, tint } = getAttachmentIcon(a.mimeType || "", a.filename);
                  return (
                    <div
                      key={`kept-${a.id}`}
                      className="group inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-soft"
                      title="مرفق من المسودة الأصلية"
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
                        aria-label="حذف المرفق"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
                {files.map((f, i) => {
                  const { Icon, tint } = getAttachmentIcon(f.type, f.name);
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
                          {formatBytes(f.size)}
                        </span>
                      </div>
                      <button
                        onClick={() => removeFile(i)}
                        disabled={sending}
                        className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
                        aria-label="حذف المرفق"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {sending && progress > 0 && (
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-brand-gradient transition-all"
                style={{ width: `${progress}%` }}
              />
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
            className="inline-flex items-center gap-2 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-brand transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60 sm:px-5 sm:py-2.5"
            title="إرسال (Ctrl+Enter)"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? (progress > 0 ? `${progress}%` : "جاري الإرسال") : "إرسال"}
          </button>
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
            disabled={sending || totalCount >= COMPOSE_MAX_FILES}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 sm:px-3"
            aria-label="إرفاق ملف"
            title="إرفاق ملف"
          >
            <Paperclip className="h-4 w-4" />
            <span className="hidden sm:inline">إرفاق</span>
          </button>
          <button
            type="button"
            onClick={saveDraftNow}
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 sm:px-3"
            aria-label="حفظ كمسودة"
            title="حفظ كمسودة"
          >
            <FileText className="h-4 w-4" />
            <span className="hidden sm:inline">حفظ كمسودة</span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground sm:gap-3">
          <span className="sm:hidden">{savedLabel}</span>
          {(to.length > 0 || cc.length > 0 || bcc.length > 0) && (
            <span>{to.length + cc.length + bcc.length} مستلم</span>
          )}
          <button
            onClick={() => void requestClose()}
            className="rounded-lg border border-input bg-background px-3 py-2 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground"
          >
            إلغاء
          </button>
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/5 backdrop-blur-sm">
          <div className="rounded-lg border-2 border-dashed border-primary/60 bg-card px-6 py-3 text-sm font-medium shadow-float">
            أفلت الملفات هنا لإرفاقها
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
          <AlertDialogHeader className="text-center sm:text-right">
            <AlertDialogTitle>لديك تغييرات غير محفوظة</AlertDialogTitle>
            <AlertDialogDescription>
              هل تريد حفظ الرسالة كمسودّة قبل المغادرة؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:justify-start">
            <button
              type="button"
              onClick={() => {
                closePrompt?.resolve("save");
                setClosePrompt(null);
              }}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              حفظ كمسودّة
            </button>
            <button
              type="button"
              onClick={() => {
                closePrompt?.resolve("discard");
                setClosePrompt(null);
              }}
              className="inline-flex h-10 items-center justify-center rounded-md border border-destructive/40 bg-background px-4 text-sm font-medium text-destructive transition hover:bg-destructive/10"
            >
              بدون حفظ
            </button>
            <button
              type="button"
              onClick={() => {
                closePrompt?.resolve("cancel");
                setClosePrompt(null);
              }}
              className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium text-muted-foreground transition hover:bg-muted"
            >
              إلغاء
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

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function fetchBlob(): Promise<Blob | null> {
    const session = getMailSession();
    if (!session) {
      toast.error("انتهت الجلسة");
      return null;
    }
    const parsed = parseMessageId(message.id);
    if (!parsed || !attachment.part) {
      toast.error("لا يمكن تحديد المرفق");
      return null;
    }
    const res = await fetch("/api/mail-attachment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mailSessionToken: session.mailSessionToken ?? "",
        password: session.password,
        folder: parsed.folder,
        uid: parsed.uid,
        part: attachment.part,
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      toast.error(`تعذّر تنزيل المرفق${msg ? `: ${msg.slice(0, 100)}` : ""}`);
      return null;
    }
    return await res.blob();
  }

  async function handleDownload() {
    if (busy || !canDownload) return;
    setBusy("download");
    try {
      const blob = await fetchBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename || "attachment";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } finally {
      setBusy(null);
    }
  }

  async function handlePreview() {
    if (busy || !canDownload || !canPreview) return;
    setBusy("preview");
    try {
      const blob = await fetchBlob();
      if (!blob) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } finally {
      setBusy(null);
    }
  }

  const { Icon: FileIcon, tint } = getAttachmentIcon(attachment.mimeType, attachment.filename);

  return (
    <>
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2.5 sm:gap-3 sm:p-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 ${tint}`}
        >
          <FileIcon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="line-clamp-2 break-all text-[13px] font-medium leading-snug sm:text-sm"
            title={attachment.filename}
          >
            {attachment.filename}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground sm:text-xs">
            <bdi dir="ltr">{formatSize(attachment.size)}</bdi>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canPreview && (
            <button
              type="button"
              onClick={handlePreview}
              disabled={!canDownload || busy !== null}
              title="معاينة"
              aria-label="معاينة"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8"
            >
              {busy === "preview" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={!canDownload || busy !== null}
            title={canDownload ? "تنزيل" : "غير متاح"}
            aria-label="تنزيل"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8"
          >
            {busy === "download" ? (
              <CircleArrowDown className="h-4 w-4 animate-bounce text-primary" />
            ) : (
              <Download className="h-4 w-4" />
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
                <Download className="h-3.5 w-3.5" /> تنزيل
              </button>
              <button
                type="button"
                onClick={() => setPreviewUrl(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/10 hover:bg-white/20"
                title="إغلاق"
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
