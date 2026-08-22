import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import {
  EmlDownloadTooLargeError,
  EmlSourceIncompleteError,
  withEmlSourceStreamInMailbox,
} from "../src/eml-download.js";

async function collectStream(
  content: Readable,
  guard: NodeJS.ReadWriteStream,
): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];

  sink.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  await pipeline(
    content,
    guard,
    sink,
  );

  return Buffer.concat(chunks);
}

test(
  "streams byte-identical RFC822 source without materializing source:true",
  async () => {
    const raw = Buffer.from(
      "From: a@example.com\r\n" +
        "To: b@example.com\r\n" +
        "Subject: Test\r\n" +
        "\r\n" +
        "Hello\r\n",
      "utf8",
    );

    const calls: string[] = [];

    const client = {
      mailbox: {
        uidValidity: "77",
      },

      async fetchOne(
        _uid: string,
        query: Record<string, unknown>,
      ) {
        if (query.source) {
          throw new Error(
            "source:true must never be used by streamed EML",
          );
        }

        calls.push("size");

        return {
          uid: 42,
          size: raw.length,
        };
      },

      async download(
        uid: string,
        part: unknown,
        options: {
          uid?: boolean;
          maxBytes?: number;
          chunkSize?: number;
        },
      ) {
        calls.push("download");

        assert.equal(uid, "42");
        assert.equal(part, undefined);
        assert.equal(options.uid, true);
        assert.equal(options.maxBytes, 101);
        assert.equal(options.chunkSize, 16);

        return {
          meta: {
            expectedSize: raw.length,
          },
          content: Readable.from([
            raw.subarray(0, 12),
            raw.subarray(12),
          ]),
        };
      },
    };

    const result =
      await withEmlSourceStreamInMailbox(
        client as never,
        42,
        "77",
        async ({
          content,
          guard,
        }) =>
          collectStream(
            content,
            guard,
          ),
        100,
        16,
      );

    assert.deepEqual(result, raw);
    assert.deepEqual(
      calls,
      ["size", "download"],
    );
  },
);

test(
  "UIDVALIDITY mismatch performs zero RFC822 I/O",
  async () => {
    let fetchCalls = 0;
    let downloadCalls = 0;

    const client = {
      mailbox: {
        uidValidity: "88",
      },

      async fetchOne() {
        fetchCalls += 1;
        return false;
      },

      async download() {
        downloadCalls += 1;
        throw new Error("must not download");
      },
    };

    await assert.rejects(
      () =>
        withEmlSourceStreamInMailbox(
          client as never,
          42,
          "77",
          async () => undefined,
        ),
      /UIDVALIDITY_MISMATCH/,
    );

    assert.equal(fetchCalls, 0);
    assert.equal(downloadCalls, 0);
  },
);

test(
  "declared oversize is rejected before opening the RFC822 stream",
  async () => {
    let downloadCalls = 0;

    const client = {
      mailbox: {
        uidValidity: "77",
      },

      async fetchOne() {
        return {
          uid: 42,
          size: 101,
        };
      },

      async download() {
        downloadCalls += 1;
        throw new Error("must not download");
      },
    };

    await assert.rejects(
      () =>
        withEmlSourceStreamInMailbox(
          client as never,
          42,
          "77",
          async () => undefined,
          100,
        ),
      EmlDownloadTooLargeError,
    );

    assert.equal(downloadCalls, 0);
  },
);

test(
  "actual stream overflow fails closed if the server declared fewer bytes",
  async () => {
    const client = {
      mailbox: {
        uidValidity: "77",
      },

      async fetchOne() {
        return {
          uid: 42,
          size: 90,
        };
      },

      async download() {
        return {
          meta: {},
          content: Readable.from([
            Buffer.alloc(60),
            Buffer.alloc(41),
          ]),
        };
      },
    };

    await assert.rejects(
      () =>
        withEmlSourceStreamInMailbox(
          client as never,
          42,
          "77",
          async ({
            content,
            guard,
          }) => {
            await pipeline(
              content,
              guard,
              new PassThrough(),
            );
          },
          100,
        ),
      EmlDownloadTooLargeError,
    );
  },
);

test(
  "truncated RFC822 stream errors before a clean destination end",
  async () => {
    const client = {
      mailbox: {
        uidValidity: "77",
      },

      async fetchOne() {
        return {
          uid: 42,
          size: 100,
        };
      },

      async download() {
        return {
          meta: {},
          content: Readable.from([
            Buffer.alloc(90),
          ]),
        };
      },
    };

    await assert.rejects(
      () =>
        withEmlSourceStreamInMailbox(
          client as never,
          42,
          "77",
          async ({
            content,
            guard,
          }) => {
            await pipeline(
              content,
              guard,
              new PassThrough(),
            );
          },
          200,
        ),
      EmlSourceIncompleteError,
    );
  },
);
