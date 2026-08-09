import { Transform, type TransformCallback } from "node:stream";

export const DOWNLOAD_CHUNK_DEFAULT_BYTES = 1024 * 1024;
export const DOWNLOAD_CHUNK_MIN_BYTES = 64 * 1024;
export const DOWNLOAD_CHUNK_MAX_BYTES = 1024 * 1024;

export function parseDownloadChunkBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DOWNLOAD_CHUNK_DEFAULT_BYTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DOWNLOAD_CHUNK_DEFAULT_BYTES;
  return Math.min(DOWNLOAD_CHUNK_MAX_BYTES, Math.max(DOWNLOAD_CHUNK_MIN_BYTES, Math.trunc(parsed)));
}

export function partialFetchCount(sizeBytes: number, chunkBytes: number): number {
  return Math.ceil(sizeBytes / chunkBytes);
}

export class DownloadByteCounter extends Transform {
  bytes = 0;
  firstByteMs: number | null = null;

  constructor(
    private readonly startedAt: number,
    private readonly now: () => number = performance.now.bind(performance),
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.firstByteMs === null && chunk.length > 0) {
      this.firstByteMs = this.now() - this.startedAt;
    }
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}
