import {
  dropAccountConnection,
  getMailboxesCached,
  TIMING_ENABLED,
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
import { collectAttachmentParts } from "./imap.js";
import type { MailAttachment } from "./types.js";
import type { MailAccount } from "./types.js";

function logDraftSourcePhase(
  enabled: boolean | undefined,
  phase: string,
  startedAt: number,
  bytes: number,
): void {
  if (!enabled || !TIMING_ENABLED) return;
  console.log(
    `[draft-route-timing] phase=${phase} ms=${Math.round(performance.now() - startedAt)} bytes=${bytes}`,
  );
}

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

export interface CanonicalDraftSourceRef {
  folderPath: string;
  uid: number;
  uidValidity: string;
}

function canonicalCid(value: string | undefined): string {
  return (value ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function uniquePart(candidates: readonly MailAttachment[], errorCode: string): MailAttachment {
  if (candidates.length !== 1 || !candidates[0]?.part) throw new Error(errorCode);
  return candidates[0];
}

/**
 * Re-establish stale X descriptors from canonical provider revision Y.
 * Matching is deliberately fail-closed: CIDs are exact, and normal parts
 * require an unambiguous filename + MIME match. We never trust an old part
 * number against a different UID.
 */
export function rebindServerSourcesFromCanonicalParts(input: {
  canonicalRef: CanonicalDraftSourceRef;
  parts: readonly MailAttachment[];
  normal: readonly ServerAttachmentSource[];
  inline: readonly ServerInlineSource[];
}): { normal: ServerAttachmentSource[]; inline: ServerInlineSource[] } {
  const usedParts = new Set<string>();
  const inline = input.inline.map((source) => {
    const expectedCid = canonicalCid(source.cid);
    const part = uniquePart(
      input.parts.filter(
        (candidate) =>
          !usedParts.has(candidate.part ?? "") &&
          canonicalCid(candidate.contentId) === expectedCid &&
          candidate.mimeType.toLowerCase() === source.mimeType.toLowerCase(),
      ),
      "DRAFT_INLINE_SOURCE_NOT_FOUND",
    );
    usedParts.add(part.part!);
    return {
      ...source,
      ...input.canonicalRef,
      part: part.part!,
      filename: part.filename,
      size: part.size,
      mimeType: part.mimeType,
    };
  });
  const normal = input.normal.map((source) => {
    const part = uniquePart(
      input.parts.filter(
        (candidate) =>
          !usedParts.has(candidate.part ?? "") &&
          candidate.filename === source.filename &&
          candidate.mimeType.toLowerCase() === source.mimeType.toLowerCase(),
      ),
      "DRAFT_ATTACHMENT_SOURCE_NOT_FOUND",
    );
    usedParts.add(part.part!);
    return {
      ...source,
      ...input.canonicalRef,
      part: part.part!,
      filename: part.filename,
      size: part.size,
      mimeType: part.mimeType,
    };
  });
  return { normal, inline };
}

export async function rebindServerSourcesToCanonicalDraft(input: {
  account: MailAccount;
  password: string;
  canonicalRef: CanonicalDraftSourceRef;
  normal: readonly ServerAttachmentSource[];
  inline: readonly ServerInlineSource[];
  draftTiming?: boolean;
}): Promise<{ normal: ServerAttachmentSource[]; inline: ServerInlineSource[] }> {
  const startedAt = performance.now();
  const mailboxes = await getMailboxesCached(input.account, input.password, "transfer");
  if (!mailboxes.some((mailbox) => mailbox.path === input.canonicalRef.folderPath)) {
    throw new Error("SOURCE_MAILBOX_MISMATCH");
  }
  try {
    const rebound = await withAccountMailbox(
      input.account,
      input.password,
      input.canonicalRef.folderPath,
      async (client) => {
        const currentUidValidity = String(
          client.mailbox && typeof client.mailbox === "object" ? client.mailbox.uidValidity : "",
        );
        if (!currentUidValidity || currentUidValidity !== input.canonicalRef.uidValidity) {
          throw new Error("SOURCE_UIDVALIDITY_MISMATCH");
        }
        const message = await client.fetchOne(
          input.canonicalRef.uid.toString(),
          { uid: true, bodyStructure: true },
          { uid: true },
        );
        if (!message || !message.bodyStructure) throw new Error("DRAFT_SOURCE_NOT_FOUND");
        return rebindServerSourcesFromCanonicalParts({
          canonicalRef: input.canonicalRef,
          parts: collectAttachmentParts(message.bodyStructure),
          normal: input.normal,
          inline: input.inline,
        });
      },
      "transfer",
    );
    logDraftSourcePhase(input.draftTiming, "canonical-source-metadata-rebind", startedAt, 0);
    return rebound;
  } catch (error) {
    dropAccountConnection(input.account, "transfer");
    throw error;
  }
}

export function draftSourceHandlesToRelease(input: {
  normal: readonly string[];
  inline: readonly string[];
  saveSucceeded: boolean;
}): string[] {
  return input.saveSucceeded ? [] : [...new Set([...input.normal, ...input.inline])];
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
            const staged = await stageAttachmentStream({
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
            return staged;
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

/** Draft-only variant with PII-safe source-transfer phase timing. */
export async function stageDraftServerAttachmentSources(input: {
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
            const downloadStartedAt = TIMING_ENABLED ? performance.now() : 0;
            const download = await client.download(source.uid.toString(), source.part, {
              uid: true,
              maxBytes: input.maxBytes + 1,
            });
            if (!download?.content) throw new Error("SOURCE_ATTACHMENT_MISSING");
            const stagingStartedAt = TIMING_ENABLED ? performance.now() : 0;
            const staged = await stageAttachmentStream({
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
              if (error instanceof Error && error.message === "UPLOAD_TOO_LARGE") {
                throw new Error("SOURCE_ATTACHMENT_TOO_LARGE");
              }
              throw error;
            });
            logDraftSourcePhase(
              true,
              "provider-normal-source-download",
              downloadStartedAt,
              staged.size,
            );
            logDraftSourcePhase(true, "normal-source-staging", stagingStartedAt, staged.size);
            return staged;
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
    draftTiming?: boolean;
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
              const downloadStartedAt = input.draftTiming && TIMING_ENABLED ? performance.now() : 0;
              const download = await client.download(source.uid.toString(), source.part, {
                uid: true,
                maxBytes: input.maxBytes + 1,
              });
              if (!download?.content) throw new Error("SOURCE_ATTACHMENT_MISSING");
              const stagingStartedAt = input.draftTiming && TIMING_ENABLED ? performance.now() : 0;
              const staged = await deps
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
              logDraftSourcePhase(
                input.draftTiming,
                "provider-inline-source-download",
                downloadStartedAt,
                staged.size,
              );
              logDraftSourcePhase(
                input.draftTiming,
                "inline-source-staging",
                stagingStartedAt,
                staged.size,
              );
              return staged;
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
