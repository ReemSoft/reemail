import {
  dropAccountConnection,
  getMailboxesCached,
  withAccountMailbox,
} from "./imap-connection.js";
import { accountBinding } from "./transfer-tickets.js";
import {
  releaseStagedAttachments,
  resolveStagedAttachment,
  stageAttachmentStream,
  type StagedAttachment,
  type ResolvedStagedAttachment,
} from "./staged-attachments.js";
import type { MailAccount } from "./types.js";

export interface ServerAttachmentSource {
  folderPath: string;
  uid: number;
  uidValidity: string;
  part: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface ServerInlineSource extends ServerAttachmentSource {
  uploadFilename: string;
  cid: string;
}

export async function stageServerAttachmentSources(input: {
  secret: string;
  account: MailAccount;
  password: string;
  sources: ServerAttachmentSource[];
  maxBytes: number;
}): Promise<Array<{ staged: StagedAttachment; resolved: ResolvedStagedAttachment }>> {
  if (input.sources.length === 0) return [];
  const account = accountBinding(input.account);
  const output: Array<{ staged: StagedAttachment; resolved: ResolvedStagedAttachment }> = [];
  let currentStaged: StagedAttachment | null = null;
  try {
    const mailboxes = await getMailboxesCached(input.account, input.password, "transfer");
    const mailboxPaths = new Set(mailboxes.map((mailbox) => mailbox.path));
    for (const source of input.sources) {
      if (!mailboxPaths.has(source.folderPath)) throw new Error("SOURCE_MAILBOX_MISMATCH");
      try {
        currentStaged = await withAccountMailbox(
          input.account,
          input.password,
          source.folderPath,
          async (client) => {
            const currentUidValidity = String(
              client.mailbox && typeof client.mailbox === "object"
                ? client.mailbox.uidValidity
                : "",
            );
            if (!currentUidValidity || currentUidValidity !== source.uidValidity) {
              throw new Error("SOURCE_UIDVALIDITY_MISMATCH");
            }
            const download = await client.download(source.uid.toString(), source.part, {
              uid: true,
              // ImapFlow's own cap truncates the DECODED stream at the limit
              // without an error, so `maxBytes` equal to the limit would hide
              // genuine overflow from the authoritative decoded-byte limiter
              // in stageAttachmentStream below. Widen the fetch window by one
              // byte: the decoded limiter then observes and rejects anything
              // at/over the limit instead of silently truncating, and the
              // transfer still aborts at ~the limit on rejection.
              maxBytes: input.maxBytes + 1,
            });
            if (!download?.content) throw new Error("SOURCE_ATTACHMENT_MISSING");
            return stageAttachmentStream({
              secret: input.secret,
              account,
              filename: source.filename,
              mimeType:
                String(
                  (download.meta as { contentType?: string }).contentType || source.mimeType,
                ) || "application/octet-stream",
              kind: "attachment",
              declaredSize: source.size,
              maxSize: input.maxBytes,
              exactSize: false,
              stream: download.content,
            }).catch((error) => {
              // The decoded-stream limiter is the authoritative size check;
              // surface its rejection as the standard attachment-limit
              // condition instead of the raw stream code.
              if (error instanceof Error && error.message === "UPLOAD_TOO_LARGE") {
                throw new Error("SOURCE_ATTACHMENT_TOO_LARGE");
              }
              throw error;
            });
          },
          "transfer",
        );
      } catch (error) {
        dropAccountConnection(input.account, "transfer");
        throw error;
      }
      output.push({
        staged: currentStaged,
        resolved: await resolveStagedAttachment(input.secret, currentStaged.handle, account),
      });
      currentStaged = null;
    }
    return output;
  } catch (error) {
    await releaseStagedAttachments(
      input.secret,
      [
        ...output.map(({ staged: item }) => item.handle),
        ...(currentStaged ? [currentStaged.handle] : []),
      ],
      account,
    ).catch(() => undefined);
    throw error;
  }
}

export interface ServerInlineSourceDeps {
  getMailboxesCached: typeof getMailboxesCached;
  withAccountMailbox: typeof withAccountMailbox;
  stageAttachmentStream: typeof stageAttachmentStream;
  resolveStagedAttachment: typeof resolveStagedAttachment;
  releaseStagedAttachments: typeof releaseStagedAttachments;
  dropAccountConnection: typeof dropAccountConnection;
}

export function createStageServerInlineSources(deps: ServerInlineSourceDeps) {
  return async function stageServerInlineSources(input: {
    secret: string;
    account: MailAccount;
    password: string;
    sources: ServerInlineSource[];
    maxBytes: number;
  }): Promise<Array<{ staged: StagedAttachment; resolved: ResolvedStagedAttachment }>> {
    if (input.sources.length === 0) return [];
    const account = accountBinding(input.account);
    const output: Array<{ staged: StagedAttachment; resolved: ResolvedStagedAttachment }> = [];
    let currentStaged: StagedAttachment | null = null;
    try {
      const mailboxes = await deps.getMailboxesCached(input.account, input.password, "transfer");
      const mailboxPaths = new Set(mailboxes.map((mailbox) => mailbox.path));
      for (const source of input.sources) {
        if (!Number.isSafeInteger(source.uid) || source.uid <= 0) {
          throw new Error("INVALID_SOURCE_UID");
        }
        if (!/^\d+(?:\.\d+)*$/.test(source.part)) {
          throw new Error("INVALID_SOURCE_PART");
        }
        if (!mailboxPaths.has(source.folderPath)) throw new Error("SOURCE_MAILBOX_MISMATCH");
        try {
          currentStaged = await deps.withAccountMailbox(
            input.account,
            input.password,
            source.folderPath,
            async (client) => {
              const currentUidValidity = String(
                client.mailbox && typeof client.mailbox === "object"
                  ? client.mailbox.uidValidity
                  : "",
              );
              if (!currentUidValidity || currentUidValidity !== source.uidValidity) {
                throw new Error("SOURCE_UIDVALIDITY_MISMATCH");
              }
              const download = await client.download(source.uid.toString(), source.part, {
                uid: true,
                maxBytes: input.maxBytes + 1,
              });
              if (!download?.content) throw new Error("SOURCE_ATTACHMENT_MISSING");
              return deps
                .stageAttachmentStream({
                  secret: input.secret,
                  account,
                  filename: source.uploadFilename,
                  mimeType:
                    String(
                      (download.meta as { contentType?: string }).contentType || source.mimeType,
                    ) || "application/octet-stream",
                  kind: "inline-image",
                  declaredSize: source.size,
                  maxSize: input.maxBytes,
                  exactSize: false,
                  stream: download.content,
                })
                .catch((error) => {
                  if (error instanceof Error && error.message === "UPLOAD_TOO_LARGE") {
                    throw new Error("SOURCE_ATTACHMENT_TOO_LARGE");
                  }
                  throw error;
                });
            },
            "transfer",
          );
        } catch (error) {
          deps.dropAccountConnection(input.account, "transfer");
          throw error;
        }
        output.push({
          staged: currentStaged,
          resolved: await deps.resolveStagedAttachment(input.secret, currentStaged.handle, account),
        });
        currentStaged = null;
      }
      return output;
    } catch (error) {
      await deps
        .releaseStagedAttachments(
          input.secret,
          [
            ...output.map(({ staged: item }) => item.handle),
            ...(currentStaged ? [currentStaged.handle] : []),
          ],
          account,
        )
        .catch(() => undefined);
      throw error;
    }
  };
}

export const stageServerInlineSources = createStageServerInlineSources({
  getMailboxesCached,
  withAccountMailbox,
  stageAttachmentStream,
  resolveStagedAttachment,
  releaseStagedAttachments,
  dropAccountConnection,
});
