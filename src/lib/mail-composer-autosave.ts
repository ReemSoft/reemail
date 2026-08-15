/**
 * Composer autosave scheduler + guard/listener helpers.
 *
 * These primitives back the Composer's dirty/save cycle and are unit-tested
 * standalone so we do not need to mount the 4000-line composer just to prove
 * lifecycle correctness. Every helper exposes a `dispose()` that is:
 *
 *   - idempotent: safe to call any number of times.
 *   - authoritative: after dispose, no callback fires and no listener remains.
 *
 * Contracts locked by `src/lib/__tests__/mail-composer-autosave.test.ts`.
 */

export interface AutosaveScheduler {
  /** Arm (or re-arm) the debounce. Rapid calls collapse into one fire. */
  schedule(): void;
  /** Fire the callback immediately, canceling any pending timer. */
  flushNow(): void;
  /** Cancel any pending timer without disposing. Idempotent. */
  cancel(): void;
  /** Cancel timer and prevent any further callback. Idempotent. */
  dispose(): void;
  /** For tests / debugging. */
  isPending(): boolean;
}

export interface CreateAutosaveSchedulerOptions {
  delayMs: number;
  onFire: () => void;
  /** Injectable for tests. Defaults to native setTimeout/clearTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function createAutosaveScheduler(opts: CreateAutosaveSchedulerOptions): AutosaveScheduler {
  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT =
    opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let disposed = false;

  function cancel() {
    if (handle !== null) {
      clearT(handle);
      handle = null;
    }
  }

  return {
    schedule() {
      if (disposed) return;
      cancel();
      handle = setT(() => {
        handle = null;
        if (disposed) return;
        opts.onFire();
      }, opts.delayMs);
    },
    flushNow() {
      if (disposed) return;
      cancel();
      opts.onFire();
    },
    cancel() {
      if (disposed) return;
      cancel();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
    },
    isPending() {
      return handle !== null;
    },
  };
}

// -------------------------------------------------------------- listeners

export interface Disposable {
  dispose(): void;
}

type EventTargetLike = {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
};

/**
 * Attach a single `input` listener (no `paste` — the browser fires `input`
 * after paste, contentEditable drop, IME commit, and text mutation, so an
 * extra `paste` listener would double-fire the caller).
 */
export function attachInputListener(target: EventTargetLike, handler: () => void): Disposable {
  let disposed = false;
  const wrapped = () => {
    if (disposed) return;
    handler();
  };
  target.addEventListener("input", wrapped);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("input", wrapped);
    },
  };
}

type WindowLike = {
  addEventListener(type: "beforeunload", listener: (ev: BeforeUnloadEvent) => void): void;
  removeEventListener(type: "beforeunload", listener: (ev: BeforeUnloadEvent) => void): void;
};

/**
 * Native `beforeunload` guard. The custom UI dialog is NEVER usable during
 * unload — every mainstream browser overrides its content with the built-in
 * confirmation. We therefore only wire the native protocol, and only fire
 * `preventDefault` while dirty so a clean composer never traps the user.
 */
export function attachBeforeUnloadGuard(win: WindowLike, isDirty: () => boolean): Disposable {
  let disposed = false;
  const handler = (e: BeforeUnloadEvent) => {
    if (disposed) return;
    if (!isDirty()) return;
    e.preventDefault();
    // Legacy contract: setting returnValue triggers the confirm on older
    // Chromium/Safari builds we still support.
    e.returnValue = "";
  };
  win.addEventListener("beforeunload", handler);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      win.removeEventListener("beforeunload", handler);
    },
  };
}

// -------------------------------------------------------------- isDraftEmpty

/**
 * Unified emptiness contract shared by autosave AND explicit `saveDraftNow`.
 * A draft is empty ONLY when every persistable field is absent — a lone
 * attachment (new file OR kept legacy attachment) is enough to prove intent
 * and MUST be persisted.
 *
 * Contract locked by mail-composer-autosave.test.ts.
 */
export interface DraftEmptinessInput {
  toCount: number;
  ccCount: number;
  bccCount: number;
  subject: string;
  htmlTrimmed: string;
  existingKeptCount: number;
  filesCount: number;
}

export function isDraftEmpty(input: DraftEmptinessInput): boolean {
  return (
    input.toCount === 0 &&
    input.ccCount === 0 &&
    input.bccCount === 0 &&
    !input.subject &&
    !input.htmlTrimmed &&
    input.existingKeptCount === 0 &&
    input.filesCount === 0
  );
}

// -------------------------------------------------- attachment-set size block
// After an authoritative attachment-size-limit failure (Bridge decoded-byte
// rejection), automatic remote draft-saves must NOT re-download the same
// attachment set every autosave tick. The block is keyed by a signature of
// the attachment set only, so body/recipient/subject edits never clear it and
// never retrigger the download. The signature changes only when the
// attachment set itself changes (add/remove/replace kept attachment, local
// file, or inline image).

export interface AttachmentSetSignatureItem {
  id?: string;
  filename?: string;
  size?: number;
  part?: string;
  name?: string;
  lastModified?: number;
  uploadFilename?: string;
}

export interface AttachmentSetSignatureInput {
  existingKept: readonly AttachmentSetSignatureItem[];
  files: readonly AttachmentSetSignatureItem[];
  inlineImages: readonly AttachmentSetSignatureItem[];
}

export function attachmentSetSignature(input: AttachmentSetSignatureInput): string {
  const kept = input.existingKept
    .map((a) => [a.id ?? "", a.filename ?? "", a.size ?? 0, a.part ?? ""].join("|"))
    .join(",");
  const local = input.files
    .map((f) => [f.name ?? "", f.size ?? 0, f.lastModified ?? 0].join("|"))
    .join(",");
  const inline = input.inlineImages
    .map((i) => [i.uploadFilename ?? "", i.filename ?? "", i.size ?? 0].join("|"))
    .join(",");
  return `${input.existingKept.length}#${kept};${input.files.length}#${local};${input.inlineImages.length}#${inline}`;
}

export interface AttachmentSizeBlockDecisionInput {
  blockedSignature: string | null;
  currentSignature: string;
}

export interface AttachmentSizeBlockDecision {
  /** False => skip the automatic remote save (attachment set still blocked). */
  remoteSaveAllowed: boolean;
  /** True => caller should clear its recorded size-block. */
  clearBlock: boolean;
}

export function decideAttachmentSizeBlock(
  input: AttachmentSizeBlockDecisionInput,
): AttachmentSizeBlockDecision {
  if (input.blockedSignature === null) {
    return { remoteSaveAllowed: true, clearBlock: false };
  }
  if (input.blockedSignature === input.currentSignature) {
    return { remoteSaveAllowed: false, clearBlock: false };
  }
  return { remoteSaveAllowed: true, clearBlock: true };
}

// -------------------------------------------------- request-bound signatures
// A save's failure may block ONLY the attachment set that request actually
// transported. The composer captures the attachment signature inside
// `saveRemote` (from the same attachment values it builds the transport from)
// and keys it by that request's generation. `onCompleted` then consumes the
// entry for the echoed generation instead of reading the live composer refs,
// so a late failure for an older request can never attribute the block to a
// newer attachment set that changed while the request was in flight.
// Entries are consumed (deleted) on completion, so the store never grows.

export interface RequestBoundSignatureStore {
  /** Bind a signature to the request that is about to transport those attachments. */
  capture(generation: number, signature: string): void;
  /**
   * Read and remove the signature captured for `generation`. Returns null
   * when no capture exists for that generation (e.g. the run short-circuited
   * before building a transport).
   */
  consume(generation: number): string | null;
  /** Number of entries still pending completion (for tests/diagnostics). */
  size(): number;
}

export function createRequestBoundSignatureStore(): RequestBoundSignatureStore {
  const byGeneration = new Map<number, string>();
  return {
    capture(generation, signature) {
      byGeneration.set(generation, signature);
    },
    consume(generation) {
      const signature = byGeneration.get(generation) ?? null;
      byGeneration.delete(generation);
      return signature;
    },
    size() {
      return byGeneration.size;
    },
  };
}
