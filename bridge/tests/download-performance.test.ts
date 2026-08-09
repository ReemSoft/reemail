import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import {
  DOWNLOAD_CHUNK_DEFAULT_BYTES,
  DOWNLOAD_CHUNK_MAX_BYTES,
  DOWNLOAD_CHUNK_MIN_BYTES,
  DownloadByteCounter,
  parseDownloadChunkBytes,
  partialFetchCount,
} from "../src/download-performance.js";

test("download chunk configuration is bounded and defaults safely", () => {
  assert.equal(parseDownloadChunkBytes(undefined), 1_048_576);
  assert.equal(parseDownloadChunkBytes("524288"), 524_288);
  for (const malformed of ["", "not-a-number", "Infinity", "0", "-1"]) {
    assert.equal(parseDownloadChunkBytes(malformed), DOWNLOAD_CHUNK_DEFAULT_BYTES);
  }
  assert.equal(parseDownloadChunkBytes("1024"), DOWNLOAD_CHUNK_MIN_BYTES);
  assert.equal(parseDownloadChunkBytes("2097152"), DOWNLOAD_CHUNK_MAX_BYTES);
  assert.equal(parseDownloadChunkBytes("70000.9"), 70_000);
});

test("request-count evidence compares the old and new partial FETCH sizes", () => {
  const mib = 1024 * 1024;
  const expected = [
    [1, 16, 1],
    [4, 64, 4],
    [10, 160, 10],
    [25, 400, 25],
  ];
  for (const [sizeMiB, oldCount, newCount] of expected) {
    assert.equal(partialFetchCount(sizeMiB * mib, 64 * 1024), oldCount);
    assert.equal(partialFetchCount(sizeMiB * mib, 1024 * 1024), newCount);
  }
});

test("byte counter streams exact bytes unchanged and records first byte", async () => {
  const chunks = [Buffer.from("alpha"), Buffer.alloc(64 * 1024, 7), Buffer.from("omega")];
  const expectedHash = createHash("sha256");
  const receivedHash = createHash("sha256");
  let totalBytes = 0;
  let receivedBytes = 0;
  for (const chunk of chunks) {
    expectedHash.update(chunk);
    totalBytes += chunk.length;
  }
  const counter = new DownloadByteCounter(100, () => 135);
  await pipeline(
    Readable.from(chunks),
    counter,
    new Writable({
      highWaterMark: 8,
      write(chunk, _encoding, callback) {
        receivedHash.update(chunk);
        receivedBytes += chunk.length;
        setImmediate(callback);
      },
    }),
  );
  assert.equal(receivedHash.digest("hex"), expectedHash.digest("hex"));
  assert.equal(receivedBytes, totalBytes);
  assert.equal(counter.bytes, totalBytes);
  assert.equal(counter.firstByteMs, 35);
  assert.ok(counter.writableHighWaterMark < totalBytes);
});
