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

export function createAutosaveScheduler(
  opts: CreateAutosaveSchedulerOptions,
): AutosaveScheduler {
  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT =
    opts.clearTimeoutFn ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
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
export function attachInputListener(
  target: EventTargetLike,
  handler: () => void,
): Disposable {
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
export function attachBeforeUnloadGuard(
  win: WindowLike,
  isDirty: () => boolean,
): Disposable {
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
