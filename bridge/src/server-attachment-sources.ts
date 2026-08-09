import {
  dropAccountConnection,
  getMailboxesCached,
  withAccountMailbox,
} from "./imap-connection.js";
import { accountBinding } from "./transfer-tickets.js";
import {
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

export async function stageServerAttachmentSources(input: {
  secret: string;
  account: MailAccount;
  password: string;
  sources: ServerAttachmentSource[];
  maxBytes: number;
}): Promise<Array<{ staged: StagedAttachment; resolved: ResolvedStagedAttachment }>> {
  const account = accountBinding(input.account);
  const mailboxes = await getMailboxesCached(input.account, input.password, "interactive");
  const mailboxPaths = new Set(mailboxes.map((mailbox) => mailbox.path));
  const output: Array<{ staged: StagedAttachment; resolved: ResolvedStagedAttachment }> = [];
  for (const source of input.sources) {
    if (!mailboxPaths.has(source.folderPath)) throw new Error("SOURCE_MAILBOX_MISMATCH");
    let staged: StagedAttachment;
    try {
      staged = await withAccountMailbox(
        input.account,
        input.password,
        source.folderPath,
        async (client) => {
          const currentUidValidity = String(
            client.mailbox && typeof client.mailbox === "object" ? client.mailbox.uidValidity : "",
          );
          if (!currentUidValidity || currentUidValidity !== source.uidValidity) {
            throw new Error("SOURCE_UIDVALIDITY_MISMATCH");
          }
          const download = await client.download(source.uid.toString(), source.part, {
            uid: true,
            maxBytes: input.maxBytes,
          });
          if (!download?.content) throw new Error("SOURCE_ATTACHMENT_MISSING");
          const expectedSize = Number(
            (download.meta as { expectedSize?: number }).expectedSize ?? source.size,
          );
          if (Number.isFinite(expectedSize) && expectedSize > input.maxBytes) {
            download.content.destroy();
            throw new Error("SOURCE_ATTACHMENT_TOO_LARGE");
          }
          return stageAttachmentStream({
            secret: input.secret,
            account,
            filename: source.filename,
            mimeType:
              String((download.meta as { contentType?: string }).contentType || source.mimeType) ||
              "application/octet-stream",
            kind: "attachment",
            declaredSize: source.size,
            maxSize: input.maxBytes,
            exactSize: false,
            stream: download.content,
          });
        },
        "interactive",
      );
    } catch (error) {
      dropAccountConnection(input.account, "interactive");
      throw error;
    }
    output.push({
      staged,
      resolved: await resolveStagedAttachment(input.secret, staged.handle, account),
    });
  }
  return output;
}
