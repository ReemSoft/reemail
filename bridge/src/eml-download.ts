import type { ImapFlow } from "imapflow";
import {
  Transform,
  type Readable,
  type TransformCallback,
} from "node:stream";
import {
  getMailboxesCached,
  withAccountMailbox,
} from "./imap-connection.js";
import {
  assertExpectedUidValidity,
  resolveFolderPath,
} from "./imap.js";
import type { MailAccount, MailFolder } from "./types.js";

export const EML_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_EML_DOWNLOAD_CHUNK_BYTES = 64 * 1024;

export class EmlDownloadTooLargeError extends Error {
  readonly code = "EML_TOO_LARGE";

  constructor() {
    super("EML_TOO_LARGE");
    this.name = "EmlDownloadTooLargeError";
  }
}

export class EmlSourceIncompleteError extends Error {
  readonly code = "EML_SOURCE_INCOMPLETE";

  constructor() {
    super("EML_SOURCE_INCOMPLETE");
    this.name = "EmlSourceIncompleteError";
  }
}

/**
 * Pass-through byte guard for the RFC822 stream.
 *
 * The guard checks the real bytes while they move to the browser. _flush()
 * validates the final byte count BEFORE emitting a clean stream end, so a
 * truncated provider response fails the HTTP pipeline instead of silently
 * completing as a valid .eml file.
 */
export class EmlSourceByteGuard extends Transform {
  bytes = 0;

  constructor(
    private readonly expectedSize: number,
    private readonly maxBytes = EML_DOWNLOAD_MAX_BYTES,
  ) {
    super();
  }

  _transform(
    chunk: any,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const size = Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.from(chunk, encoding).length;

    const next = this.bytes + size;

    if (next > this.maxBytes) {
      callback(new EmlDownloadTooLargeError());
      return;
    }

    this.bytes = next;
    callback(null, chunk);
  }

  _flush(callback: TransformCallback): void {
    if (this.bytes !== this.expectedSize) {
      callback(new EmlSourceIncompleteError());
      return;
    }

    callback();
  }
}

export interface EmlSourceStream {
  content: Readable;
  declaredSize: number;
  guard: EmlSourceByteGuard;
}

export type EmlSourceConsumer<T> = (
  source: EmlSourceStream,
) => Promise<T>;

/**
 * Opens the original RFC822 source as a bounded stream and keeps the caller's
 * consumer inside the same mailbox operation.
 *
 * No full-message Buffer is created. The only preflight operation is a
 * size-only FETCH, used to reject obviously oversized messages before source
 * bytes start flowing.
 */
export async function withEmlSourceStreamInMailbox<T>(
  client: ImapFlow,
  uid: number,
  expectedUidValidity: string,
  consume: EmlSourceConsumer<T>,
  maxBytes = EML_DOWNLOAD_MAX_BYTES,
  chunkSize = DEFAULT_EML_DOWNLOAD_CHUNK_BYTES,
): Promise<T | null> {
  assertExpectedUidValidity(client, expectedUidValidity);

  const metadata = await client.fetchOne(
    String(uid),
    { uid: true, size: true },
    { uid: true },
  );

  if (!metadata) return null;

  const returnedUid = Number((metadata as { uid?: unknown }).uid);
  if (returnedUid !== uid) return null;

  const declaredSize = Number((metadata as { size?: unknown }).size);

  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    return null;
  }

  if (declaredSize > maxBytes) {
    throw new EmlDownloadTooLargeError();
  }

  // Omitting the MIME part asks ImapFlow for the complete RFC822 message.
  // maxBytes+1 lets our pass-through guard observe a lying/incorrect server
  // crossing the hard limit and fail the HTTP stream deterministically.
  const download = await client.download(
    String(uid),
    undefined,
    {
      uid: true,
      maxBytes: maxBytes + 1,
      chunkSize,
    },
  );

  if (!download?.content) return null;

  const guard = new EmlSourceByteGuard(
    declaredSize,
    maxBytes,
  );

  try {
    return await consume({
      content: download.content,
      declaredSize,
      guard,
    });
  } catch (error) {
    download.content.destroy();
    throw error;
  }
}

/**
 * Dedicated transfer-lane wrapper.
 *
 * The consumer is awaited INSIDE withAccountMailbox(), so the transfer mailbox
 * lock and lane remain owned until the RFC822 stream finishes or aborts.
 * Message-open/CID/background/Draft lanes never wait behind this transfer.
 */
export async function withEmlSourceStream<T>(
  account: MailAccount,
  password: string,
  folder: MailFolder,
  uid: number,
  expectedUidValidity: string,
  consume: EmlSourceConsumer<T>,
  maxBytes = EML_DOWNLOAD_MAX_BYTES,
  chunkSize = DEFAULT_EML_DOWNLOAD_CHUNK_BYTES,
): Promise<T | null> {
  const mailboxes = await getMailboxesCached(
    account,
    password,
    "transfer",
  );

  const path = resolveFolderPath(mailboxes, folder);
  if (!path) return null;

  return withAccountMailbox(
    account,
    password,
    path,
    (client) =>
      withEmlSourceStreamInMailbox(
        client,
        uid,
        expectedUidValidity,
        consume,
        maxBytes,
        chunkSize,
      ),
    "transfer",
  );
}
