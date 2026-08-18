/**
 * Draft-only orchestration decisions for opening and sending Working Drafts.
 *
 * These helpers are intentionally small and UI-agnostic. mail.tsx owns the
 * actual fetch/UI side effects; the decisions here are what the regression
 * tests exercise so a stale provider UID can never masquerade as a logical
 * Draft.
 */
import type { WorkingDraftRecord } from "@/lib/mail-working-draft";

export function shouldUseLocalIndexForFolder(input: {
  folder: string;
  sort: string;
  mailIndexEnabled: boolean;
  hasMailSessionToken: boolean;
}): boolean {
  return (
    input.mailIndexEnabled &&
    input.sort === "date-desc" &&
    input.hasMailSessionToken &&
    input.folder !== "starred"
  );
}

export function draftSendNeedsWorkingDraftPersist(input: {
  workingRevision: number;
  dirty: boolean;
}): boolean {
  return input.workingRevision <= 0 || input.dirty;
}

export function isDraftEditComposeInitial(initial: {
  editDraftId?: string | null;
}): boolean {
  return Boolean(initial.editDraftId);
}

export type DraftOpenTarget =
  | { kind: "server-working"; record: WorkingDraftRecord }
  | { kind: "working-by-header"; draftId: string }
  | { kind: "provider-fallback" };

export function chooseDraftOpenTarget(input: {
  rowId: string;
  draftIdHeader?: string;
  uidValidity?: string;
  uid: number;
  records: readonly WorkingDraftRecord[];
  isDraftIdValid: (value: string) => boolean;
}): DraftOpenTarget {
  const serverDraftId = input.rowId.startsWith("working-draft:")
    ? input.rowId.slice("working-draft:".length)
    : null;
  if (serverDraftId) {
    const record = input.records.find((candidate) => candidate.draftId === serverDraftId);
    return record
      ? { kind: "server-working", record }
      : { kind: "working-by-header", draftId: serverDraftId };
  }

  const headerId = input.draftIdHeader?.trim();
  if (headerId && input.isDraftIdValid(headerId)) {
    const record = input.records.find((candidate) => candidate.draftId === headerId);
    if (record) return { kind: "server-working", record };
    return { kind: "working-by-header", draftId: headerId };
  }

  if (input.uidValidity) {
    const record = input.records.find(
      (candidate) =>
        candidate.checkpoint.serverRef?.uidValidity === input.uidValidity &&
        candidate.checkpoint.serverRef?.uid === input.uid,
    );
    if (record) return { kind: "server-working", record };
  }

  return { kind: "provider-fallback" };
}
