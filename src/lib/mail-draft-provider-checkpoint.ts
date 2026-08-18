/**
 * Draft-only provider checkpoint orchestration primitives.
 *
 * Working Draft persistence is fast and authoritative. Provider IMAP Draft is
 * only an interoperability checkpoint and must never gate Save, Close, or Send.
 */

export const DRAFT_PROVIDER_CHECKPOINT_CADENCE_MS = 5 * 60_000;

export function isDraftProviderCheckpointFenced(state: string | null | undefined): boolean {
  return state === "sent" || state === "sending";
}

export function shouldRunProviderCheckpoint(input: {
  latestWorkingRevision: number;
  lastCheckpointedRevision: number;
}): boolean {
  return input.latestWorkingRevision > input.lastCheckpointedRevision;
}

export function coalesceLatestProviderCheckpoint(input: {
  runningRevision: number | null;
  latestRequestedRevision: number;
}): number | null {
  if (input.runningRevision === null) return input.latestRequestedRevision;
  return input.latestRequestedRevision > input.runningRevision
    ? input.latestRequestedRevision
    : null;
}
