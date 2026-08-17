/**
 * Working-Draft-only bounded concurrency runner.
 *
 * Used by the server attachment transfer path so a slow/failing attachment
 * cannot serialize all unrelated attachments, while still guaranteeing input
 * order and deterministic failure cleanup.
 */

export const WORKING_DRAFT_STAGE_CONCURRENCY = 3;

export async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let active = 0;
  let failure: unknown | null = null;
  let stopScheduling = false;

  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (active !== 0) return;
      if (stopScheduling || nextIndex >= items.length) {
        if (failure !== null) reject(failure);
        else resolve();
      }
    };

    const startNext = () => {
      if (stopScheduling) {
        settle();
        return;
      }
      while (active < limit && nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        active += 1;
        worker(items[index], index).then(
          (value) => {
            results[index] = value;
            active -= 1;
            startNext();
          },
          (error) => {
            if (failure === null) {
              failure = error;
              stopScheduling = true;
            }
            active -= 1;
            startNext();
          },
        );
      }
      settle();
    };

    startNext();
  });

  if (failure !== null) throw failure;
  return results;
}
