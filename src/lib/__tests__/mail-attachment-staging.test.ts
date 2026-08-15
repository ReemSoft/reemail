// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n, { tr } from "@/i18n";
import {
  ATTACHMENT_PREPARATION_MESSAGE_KEY,
  getOrCreateStagedUpload,
  getStagedReady,
  isAttachmentPreparationProtocolError,
  isAttachmentSizeLimitError,
  uploadAttachmentDirect,
  type StagedAttachmentKind,
  type StagedAttachmentResult,
  type StagedUploadCache,
  type StagedReadyCache,
} from "../mail-attachment-staging";
import { buildStagedAttachmentTransport } from "../mail-composer-attachments";

function staged(
  kind: StagedAttachmentKind,
  filename: string,
  handle = `${kind}-${filename}`,
): StagedAttachmentResult {
  return {
    handle,
    filename,
    size: 1,
    mimeType: "image/png",
    kind,
    expiresAt: Date.now() + 60_000,
  };
}

describe("kind-aware attachment staging", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await i18n.changeLanguage("ar");
  });

  it.each([
    ["attachment", "inline-image"],
    ["inline-image", "attachment"],
  ] as const)(
    "stages the same File as %s then %s without cross-kind reuse",
    async (first, second) => {
      const file = new File(["x"], "same.png", { type: "image/png" });
      const cache: StagedUploadCache = new WeakMap();
      const createFirst = vi.fn(async () => staged(first, file.name));
      const createSecond = vi.fn(async () => staged(second, file.name));

      const firstResult = await getOrCreateStagedUpload(cache, file, first, file.name, createFirst);
      const secondResult = await getOrCreateStagedUpload(
        cache,
        file,
        second,
        file.name,
        createSecond,
      );

      expect(firstResult.kind).toBe(first);
      expect(secondResult.kind).toBe(second);
      expect(firstResult.handle).not.toBe(secondResult.handle);
      expect(createFirst).toHaveBeenCalledOnce();
      expect(createSecond).toHaveBeenCalledOnce();
    },
  );

  it("reuses one upload for the same File, kind and logical filename", async () => {
    const file = new File(["x"], "same.png", { type: "image/png" });
    const cache: StagedUploadCache = new WeakMap();
    const create = vi.fn(async () => staged("inline-image", "logical.png"));

    const first = getOrCreateStagedUpload(cache, file, "inline-image", "logical.png", create);
    const second = getOrCreateStagedUpload(cache, file, "inline-image", "logical.png", create);

    expect(first).toBe(second);
    expect(await first).toEqual(await second);
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not reuse a same-kind handle when the logical inline filename changed", async () => {
    const file = new File(["x"], "same.png", { type: "image/png" });
    const cache: StagedUploadCache = new WeakMap();
    const first = vi.fn(async () => staged("inline-image", "first.png"));
    const second = vi.fn(async () => staged("inline-image", "second.png"));

    await getOrCreateStagedUpload(cache, file, "inline-image", "first.png", first);
    const result = await getOrCreateStagedUpload(cache, file, "inline-image", "second.png", second);

    expect(result.filename).toBe("second.png");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("does not expose ready metadata under the wrong kind or logical filename", () => {
    const file = new File(["x"], "same.png", { type: "image/png" });
    const ready: StagedReadyCache = new WeakMap([
      [file, new Map([["inline-image", staged("inline-image", "current.png")]])],
    ]);

    expect(getStagedReady(ready, file, "attachment", "current.png")).toBeUndefined();
    expect(getStagedReady(ready, file, "inline-image", "old.png")).toBeUndefined();
    expect(getStagedReady(ready, file, "inline-image", "current.png")?.filename).toBe(
      "current.png",
    );
  });

  it("evicts a failed upload so a customer retry starts a fresh request", async () => {
    const file = new File(["x"], "same.png", { type: "image/png" });
    const cache: StagedUploadCache = new WeakMap();
    const failed = vi.fn(async () => {
      throw new Error("network");
    });
    await expect(
      getOrCreateStagedUpload(cache, file, "attachment", file.name, failed),
    ).rejects.toThrow("network");
    const retry = vi.fn(async () => staged("attachment", file.name));

    await expect(
      getOrCreateStagedUpload(cache, file, "attachment", file.name, retry),
    ).resolves.toMatchObject({ kind: "attachment" });
    expect(failed).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("reuses completed autosave staging for Send without another upload", async () => {
    const file = new File(["x"], "inline-image", { type: "image/png" });
    const cache: StagedUploadCache = new WeakMap();
    const create = vi.fn(async () => staged("inline-image", "mm-inline.png"));
    const autosave = await getOrCreateStagedUpload(
      cache,
      file,
      "inline-image",
      "mm-inline.png",
      create,
    );
    const send = await getOrCreateStagedUpload(
      cache,
      file,
      "inline-image",
      "mm-inline.png",
      create,
    );
    const payload = buildStagedAttachmentTransport({
      plan: {
        attachmentHandles: [],
        sourceAttachments: [],
        sourceAttachmentIds: [],
        unresolvedAttachmentIds: [],
      },
      normal: [],
      inline: [send],
      inlineMetadata: [
        { uploadFilename: "mm-inline.png", cid: "cid@example", contentType: "image/png" },
      ],
    });

    expect(send).toBe(autosave);
    expect(payload.stagedInlineImages[0].uploadFilename).toBe(send.filename);
    expect(create).toHaveBeenCalledOnce();
  });

  it("shares in-flight staging when Send overlaps autosave", async () => {
    const file = new File(["x"], "inline-image", { type: "image/png" });
    const cache: StagedUploadCache = new WeakMap();
    let resolveUpload!: (value: StagedAttachmentResult) => void;
    const pending = new Promise<StagedAttachmentResult>((resolve) => {
      resolveUpload = resolve;
    });
    const create = vi.fn(() => pending);
    const autosave = getOrCreateStagedUpload(cache, file, "inline-image", "mm-inline.png", create);
    const send = getOrCreateStagedUpload(cache, file, "inline-image", "mm-inline.png", create);

    expect(send).toBe(autosave);
    resolveUpload(staged("inline-image", "mm-inline.png"));
    expect((await send).kind).toBe("inline-image");
    expect(create).toHaveBeenCalledOnce();
  });

  it("tickets the logical inline filename while streaming the original File bytes", async () => {
    const file = new File(["same bytes"], "inline-image", { type: "image/png" });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        filename: "mm-inline-logical.png",
        kind: "inline-image",
      });
      return new Response(
        JSON.stringify({ ok: true, uploadUrl: "https://bridge.test/upload", ticket: "ticket" }),
        { status: 200 },
      );
    });
    let streamed: File | null = null;
    class FakeXhr {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      status = 200;
      responseText = JSON.stringify({
        ok: true,
        ...staged("inline-image", "mm-inline-logical.png", "inline-handle"),
      });
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      getResponseHeader() {
        return null;
      }
      abort() {}
      send(body: File) {
        streamed = body;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);

    const result = await uploadAttachmentDirect(file, {
      mailSessionToken: "token",
      kind: "inline-image",
      filename: "mm-inline-logical.png",
    });

    expect(result.filename).toBe("mm-inline-logical.png");
    expect(streamed).toBe(file);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps the generic protocol code to localized customer-safe text", async () => {
    expect(isAttachmentPreparationProtocolError("ATTACHMENT_KIND_MISMATCH")).toBe(true);
    expect(isAttachmentPreparationProtocolError("SEND_BUSY")).toBe(false);
    await i18n.changeLanguage("ar");
    expect(tr(ATTACHMENT_PREPARATION_MESSAGE_KEY)).toBe(
      "تعذّر تجهيز المرفقات للإرسال. أعد المحاولة.",
    );
    await i18n.changeLanguage("en");
    expect(tr(ATTACHMENT_PREPARATION_MESSAGE_KEY)).toBe(
      "Attachments could not be prepared for sending. Please try again.",
    );
  });

  it("classifies attachment size-limit codes for clear surfacing", () => {
    expect(isAttachmentSizeLimitError("ATTACHMENTS_TOO_LARGE")).toBe(true);
    expect(isAttachmentSizeLimitError("SOURCE_ATTACHMENT_TOO_LARGE")).toBe(true);
    expect(isAttachmentSizeLimitError("ATTACHMENT_LIMIT_EXCEEDED")).toBe(true);
    expect(isAttachmentSizeLimitError("ATTACHMENT_KIND_MISMATCH")).toBe(false);
    expect(isAttachmentSizeLimitError("SEND_BUSY")).toBe(false);
    expect(isAttachmentSizeLimitError(undefined)).toBe(false);
  });
});
