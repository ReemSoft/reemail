/**
 * Browser-side serialization for visible-message CID/media work.
 *
 * Bridge admits one non-body/media operation per account. Small-CID
 * resolution and deferred/large-CID hydration are independent React effects;
 * without this queue they can race each other and create IMAP_BUSY.
 *
 * Message/body opening never uses this helper.
 */
const tails = new Map<string, Promise<void>>();

function abortError(): Error {
  const error = new Error("INLINE_MEDIA_ABORTED");
  error.name = "AbortError";
  return error;
}

export async function runInlineMediaQueued<T>(
  accountId: string,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  const key = accountId.trim();
  if (!key) throw new Error("INLINE_MEDIA_ACCOUNT_REQUIRED");

  const previous = tails.get(key) ?? Promise.resolve();

  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => hold);
  tails.set(key, tail);

  const cleanup = () => {
    if (tails.get(key) === tail) tails.delete(key);
  };

  await previous.catch(() => undefined);

  if (signal.aborted) {
    release();
    void tail.finally(cleanup);
    throw abortError();
  }

  try {
    return await task();
  } finally {
    release();
    void tail.finally(cleanup);
  }
}

export function inlineMediaQueueSizeForTests(): number {
  return tails.size;
}

export function resetInlineMediaQueueForTests(): void {
  tails.clear();
}
