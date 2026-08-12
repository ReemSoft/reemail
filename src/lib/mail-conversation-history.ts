import type { ConversationRow } from "@/lib/mail-conversation.functions";

export const INITIAL_CONVERSATION_HISTORY_LIMIT = 25;

export interface ConversationAnchor {
  id: string;
  uidValidity?: string;
  date: string;
}

function physicalKey(folder: string, uid: number, uidValidity: string): string {
  return `${folder}:${uid}:${uidValidity}`;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const FOLDER_ORDER: Record<ConversationRow["folder"], number> = {
  inbox: 0,
  starred: 1,
  sent: 2,
  drafts: 3,
  spam: 4,
  trash: 5,
  archive: 6,
  all: 7,
};

function numericIdentity(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function comparePhysicalPosition(
  left: Pick<ConversationRow, "folder" | "uid" | "uidValidity" | "date">,
  right: Pick<ConversationRow, "folder" | "uid" | "uidValidity" | "date">,
): number {
  const dateDelta = timestamp(left.date) - timestamp(right.date);
  if (dateDelta !== 0) return dateDelta;
  const folderDelta = FOLDER_ORDER[left.folder] - FOLDER_ORDER[right.folder];
  if (folderDelta !== 0) return folderDelta;
  const uidDelta = left.uid - right.uid;
  if (uidDelta !== 0) return uidDelta;
  const leftUidValidity = numericIdentity(left.uidValidity);
  const rightUidValidity = numericIdentity(right.uidValidity);
  return leftUidValidity < rightUidValidity ? -1 : leftUidValidity > rightUidValidity ? 1 : 0;
}

/**
 * Prepares only messages chronologically before the selected message. The
 * input is already-local thread metadata; this helper performs no I/O and
 * keeps the initial rendered history bounded to the existing limit.
 */
export function prepareConversationHistory(
  rows: readonly ConversationRow[],
  selected: ConversationAnchor,
): ConversationRow[] {
  const separator = selected.id.indexOf(":");
  const selectedFolder = separator > 0 ? selected.id.slice(0, separator) : "";
  const selectedUid = separator > 0 ? Number(selected.id.slice(separator + 1)) : Number.NaN;
  const selectedPosition = {
    folder: selectedFolder as ConversationRow["folder"],
    uid: selectedUid,
    uidValidity: selected.uidValidity ?? "",
    date: selected.date,
  };
  const selectedKey = Number.isFinite(selectedUid) ? `${selectedFolder}:${selectedUid}` : null;
  const seen = new Set<string>();

  return rows
    .filter((row) => {
      const key = physicalKey(row.folder, row.uid, row.uidValidity);
      if (seen.has(key) || `${row.folder}:${row.uid}` === selectedKey) return false;
      seen.add(key);
      return comparePhysicalPosition(row, selectedPosition) < 0;
    })
    .sort((left, right) => comparePhysicalPosition(right, left))
    .slice(0, INITIAL_CONVERSATION_HISTORY_LIMIT);
}
