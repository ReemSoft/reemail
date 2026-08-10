import type { MailAttachment, MailFolder, MailMessage } from "@/lib/mail-types";
import type { DraftAttachmentSourceRef, DraftSourceAttachment } from "@/lib/mail-draft-lifecycle";

export interface AttachmentSourceRef {
  folderPath: string;
  uid: number;
  uidValidity: string;
}

export interface SourceAttachmentTransport {
  folderPath: string;
  uid: number;
  uidValidity: string;
  part: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface AttachmentTransportPlan {
  attachmentHandles: string[];
  sourceAttachments: SourceAttachmentTransport[];
  sourceAttachmentIds: string[];
  unresolvedAttachmentIds: string[];
}

const MAIL_FOLDERS: ReadonlySet<string> = new Set<MailFolder>([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
]);

function normalizeCid(value: string | undefined): string {
  return (value ?? "").replace(/^<|>$/g, "").trim().toLowerCase();
}

/** One rule for Draft edit, Reply, Reply All and Forward attachment chips. */
export function selectNormalComposerAttachments(message: MailMessage): MailAttachment[] {
  const bodyCids = new Set(
    Array.from((message.body ?? "").matchAll(/cid:([^"'\s>)\\]+)/gi), (match) =>
      normalizeCid(match[1]),
    ),
  );
  const inlineParts = new Set((message.inlineParts ?? []).map((part) => part.part));
  return (message.attachments ?? []).filter((attachment) => {
    if (attachment.part && inlineParts.has(attachment.part)) return false;
    const cid = normalizeCid(attachment.contentId);
    if (cid && bodyCids.has(cid)) return false;
    if (attachment.disposition === "inline" && cid) return false;
    return true;
  });
}

/** Resolve the source message to its real mailbox path; never guess folder names. */
export function deriveAttachmentSourceRef(
  message: MailMessage,
  folderPaths: Partial<Record<MailFolder, string>>,
): AttachmentSourceRef | null {
  const separator = message.id.indexOf(":");
  if (separator <= 0) return null;
  const canonical = message.id.slice(0, separator);
  const uidText = message.id.slice(separator + 1);
  if (!MAIL_FOLDERS.has(canonical) || !/^\d+$/.test(uidText)) return null;
  const folder = canonical as MailFolder;
  const uid = Number(uidText);
  const folderPath = folderPaths[folder]?.trim();
  const uidValidity = message.uidValidity?.trim();
  if (!folderPath || !Number.isSafeInteger(uid) || uid <= 0 || !uidValidity) return null;
  return { folderPath, uid, uidValidity };
}

export function buildLocalSourceAttachmentState(input: {
  attachments: readonly MailAttachment[];
  restoredHandles: ReadonlyMap<string, string>;
  preservedHandles: ReadonlyMap<string, string>;
  sourceRef: AttachmentSourceRef | null;
}): { sourceRef: DraftAttachmentSourceRef; attachments: DraftSourceAttachment[] } | undefined {
  if (!input.sourceRef) return undefined;
  const attachments = input.attachments
    .filter(
      (attachment) =>
        !input.restoredHandles.has(attachment.id) && !input.preservedHandles.has(attachment.id),
    )
    .map((attachment) => ({
      id: attachment.id,
      part: attachment.part,
      filename: attachment.filename,
      size: attachment.size,
      mimeType: attachment.mimeType,
      disposition: attachment.disposition,
      contentId: attachment.contentId,
    }));
  if (attachments.length === 0) return undefined;
  return { sourceRef: input.sourceRef, attachments };
}

/**
 * Build the handle/source split by stable attachment id. Every kept row gets
 * exactly one transport or is reported unresolved so callers can fail closed.
 */
export function buildAttachmentTransportPlan(input: {
  attachments: readonly MailAttachment[];
  restoredHandles: ReadonlyMap<string, string>;
  preservedHandles: ReadonlyMap<string, string>;
  sourceRef: AttachmentSourceRef | null;
}): AttachmentTransportPlan {
  const attachmentHandles: string[] = [];
  const sourceAttachments: SourceAttachmentTransport[] = [];
  const sourceAttachmentIds: string[] = [];
  const unresolvedAttachmentIds: string[] = [];

  for (const attachment of input.attachments) {
    const restored = input.restoredHandles.get(attachment.id);
    if (restored) {
      attachmentHandles.push(restored);
      continue;
    }
    const preserved = input.preservedHandles.get(attachment.id);
    if (preserved) {
      attachmentHandles.push(preserved);
      continue;
    }
    if (input.sourceRef && attachment.part && /^\d+(?:\.\d+)*$/.test(attachment.part)) {
      sourceAttachmentIds.push(attachment.id);
      sourceAttachments.push({
        ...input.sourceRef,
        part: attachment.part,
        filename: attachment.filename,
        size: attachment.size,
        mimeType: attachment.mimeType || "application/octet-stream",
      });
      continue;
    }
    unresolvedAttachmentIds.push(attachment.id);
  }

  return { attachmentHandles, sourceAttachments, sourceAttachmentIds, unresolvedAttachmentIds };
}
