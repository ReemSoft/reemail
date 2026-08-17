import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createStageServerInlineSources,
  draftSourceHandlesToRelease,
  rebindServerSourcesFromCanonicalParts,
  type ServerAttachmentSource,
  type ServerInlineSource,
  type ServerInlineSourceDeps,
} from "../src/server-attachment-sources.js";
import type { MailAccount } from "../src/types.js";

const ACCOUNT: MailAccount = {
  email_address: "user@example.com",
  display_name: "User",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_secure: true,
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_secure: true,
};

function source(overrides: Partial<ServerInlineSource> = {}): ServerInlineSource {
  return {
    folderPath: "Drafts",
    uid: 10,
    uidValidity: "1000",
    part: "1.2",
    filename: "inline.png",
    size: 3,
    mimeType: "image/png",
    uploadFilename: "mm-inline-a.png",
    cid: "cid-a@mailmaestro",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ServerInlineSourceDeps> = {}): {
  deps: ServerInlineSourceDeps;
  calls: {
    mailboxes: string[][];
    downloads: Array<{ uid: string; part: string }>;
    staged: Array<{
      filename: string;
      kind: string;
      mimeType: string;
    }>;
  };
} {
  const calls = {
    mailboxes: [] as string[][],
    downloads: [] as Array<{ uid: string; part: string }>,
    staged: [] as Array<{ filename: string; kind: string; mimeType: string }>,
  };
  const deps: ServerInlineSourceDeps = {
    getMailboxesCached: async () => {
      const list = ["INBOX", "Drafts"];
      calls.mailboxes.push(list);
      return list.map((path) => ({ path })) as never;
    },
    withAccountMailbox: async (_account, _password, path, fn) => {
      assert.equal(path, "Drafts");
      const client = {
        mailbox: { uidValidity: BigInt(1000) },
        download: async (uid: string, part: string) => {
          calls.downloads.push({ uid, part });
          return {
            content: Readable.from([Buffer.from("abc")]),
            meta: { contentType: "image/png" },
          };
        },
      };
      return fn(client as never);
    },
    stageAttachmentStream: async (input) => {
      calls.staged.push({
        filename: input.filename,
        kind: input.kind,
        mimeType: input.mimeType,
      });
      return {
        handle: `handle-${input.filename}`,
        filename: input.filename,
        size: input.declaredSize,
        mimeType: input.mimeType,
        kind: input.kind,
        expiresAt: 1,
      };
    },
    resolveStagedAttachment: async (_secret, handle) => ({
      filename: handle.replace("handle-", ""),
      size: 3,
      mimeType: "image/png",
      kind: "inline-image",
      path: `/tmp/${handle}`,
    }),
    releaseStagedAttachments: async () => true,
    dropAccountConnection: () => {},
    ...overrides,
  };
  return { deps, calls };
}

test("valid restored inline source fetches exact part and stages inline-image once", async () => {
  const { deps, calls } = makeDeps();
  const stage = createStageServerInlineSources(deps);
  const [result] = await stage({
    secret: "secret",
    account: ACCOUNT,
    password: "pw",
    sources: [source()],
    maxBytes: 100,
  });
  assert.deepEqual(calls.downloads, [{ uid: "10", part: "1.2" }]);
  assert.deepEqual(calls.staged, [
    { filename: "mm-inline-a.png", kind: "inline-image", mimeType: "image/png" },
  ]);
  assert.equal(result.staged.handle, "handle-mm-inline-a.png");
  assert.equal(result.resolved.kind, "inline-image");
});

test("multiple restored sources stage each exact source once", async () => {
  const { deps, calls } = makeDeps();
  const stage = createStageServerInlineSources(deps);
  const results = await stage({
    secret: "secret",
    account: ACCOUNT,
    password: "pw",
    sources: [
      source({ part: "1.2", uploadFilename: "a.png", cid: "cid-a@mailmaestro" }),
      source({ part: "2.1", uploadFilename: "b.png", cid: "cid-b@mailmaestro" }),
    ],
    maxBytes: 100,
  });
  assert.equal(calls.downloads.length, 2);
  assert.deepEqual(calls.downloads[0], { uid: "10", part: "1.2" });
  assert.deepEqual(calls.downloads[1], { uid: "10", part: "2.1" });
  assert.deepEqual(
    results.map((r) => r.staged.handle),
    ["handle-a.png", "handle-b.png"],
  );
});

test("UIDVALIDITY mismatch fails before staging", async () => {
  const { deps, calls } = makeDeps({
    withAccountMailbox: async (_account, _password, _path, fn) => {
      const client = {
        mailbox: { uidValidity: BigInt(999) },
        download: async () => {
          throw new Error("should not download");
        },
      };
      return fn(client as never);
    },
  });
  const stage = createStageServerInlineSources(deps);
  await assert.rejects(
    stage({
      secret: "secret",
      account: ACCOUNT,
      password: "pw",
      sources: [source()],
      maxBytes: 100,
    }),
    /SOURCE_UIDVALIDITY_MISMATCH/,
  );
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.staged.length, 0);
});

test("missing MIME part produces typed failure", async () => {
  const { deps, calls } = makeDeps({
    withAccountMailbox: async (_account, _password, _path, fn) => {
      const client = {
        mailbox: { uidValidity: BigInt(1000) },
        download: async () => null,
      };
      return fn(client as never);
    },
  });
  const stage = createStageServerInlineSources(deps);
  await assert.rejects(
    stage({
      secret: "secret",
      account: ACCOUNT,
      password: "pw",
      sources: [source()],
      maxBytes: 100,
    }),
    /SOURCE_ATTACHMENT_MISSING/,
  );
  assert.equal(calls.staged.length, 0);
});

test("mailbox mismatch prevents source fetch", async () => {
  const { deps, calls } = makeDeps();
  const stage = createStageServerInlineSources(deps);
  await assert.rejects(
    stage({
      secret: "secret",
      account: ACCOUNT,
      password: "pw",
      sources: [source({ folderPath: "Not-Account-Mailbox" })],
      maxBytes: 100,
    }),
    /SOURCE_MAILBOX_MISMATCH/,
  );
  assert.equal(calls.downloads.length, 0);
});

test("invalid UID and invalid part are rejected before fetch", async () => {
  const { deps, calls } = makeDeps();
  const stage = createStageServerInlineSources(deps);
  await assert.rejects(
    stage({
      secret: "secret",
      account: ACCOUNT,
      password: "pw",
      sources: [source({ uid: 0 })],
      maxBytes: 100,
    }),
    /INVALID_SOURCE_UID/,
  );
  await assert.rejects(
    stage({
      secret: "secret",
      account: ACCOUNT,
      password: "pw",
      sources: [source({ part: "../etc" })],
      maxBytes: 100,
    }),
    /INVALID_SOURCE_PART/,
  );
  assert.equal(calls.downloads.length, 0);
});

test("source fetch throw surfaces as typed/safe failure", async () => {
  const { deps, calls } = makeDeps({
    withAccountMailbox: async (_account, _password, _path, fn) => {
      const client = {
        mailbox: { uidValidity: BigInt(1000) },
        download: async () => {
          throw new Error("SOURCE_ATTACHMENT_MISSING");
        },
      };
      return fn(client as never);
    },
  });
  const stage = createStageServerInlineSources(deps);
  await assert.rejects(
    stage({
      secret: "secret",
      account: ACCOUNT,
      password: "pw",
      sources: [source()],
      maxBytes: 100,
    }),
    /SOURCE_ATTACHMENT_MISSING/,
  );
  assert.equal(calls.staged.length, 0);
});

test("returned handle maps deterministically back to source order", async () => {
  const { deps } = makeDeps();
  const stage = createStageServerInlineSources(deps);
  const results = await stage({
    secret: "secret",
    account: ACCOUNT,
    password: "pw",
    sources: [
      source({ uploadFilename: "a.png", cid: "cid-a@mailmaestro" }),
      source({ uploadFilename: "b.png", cid: "cid-b@mailmaestro" }),
    ],
    maxBytes: 100,
  });
  assert.deepEqual(
    results.map((r) => r.staged.handle),
    ["handle-a.png", "handle-b.png"],
  );
});

test("later Draft save failure releases normal and inline server-source handles", () => {
  assert.deepEqual(
    draftSourceHandlesToRelease({
      normal: ["normal-handle"],
      inline: ["inline-handle"],
      saveSucceeded: false,
    }),
    ["normal-handle", "inline-handle"],
  );
  assert.deepEqual(
    draftSourceHandlesToRelease({
      normal: ["normal-handle"],
      inline: ["inline-handle"],
      saveSucceeded: true,
    }),
    [],
  );
});

test("stale X normal and inline descriptors rebind to canonical Y parts", () => {
  const normal: ServerAttachmentSource = {
    folderPath: "Drafts",
    uid: 10,
    uidValidity: "1000",
    part: "1.2",
    filename: "report.pdf",
    size: 100,
    mimeType: "application/pdf",
  };
  const rebound = rebindServerSourcesFromCanonicalParts({
    canonicalRef: { folderPath: "Drafts", uid: 71, uidValidity: "2000" },
    normal: [normal],
    inline: [source()],
    parts: [
      {
        id: "2",
        part: "2",
        filename: "report.pdf",
        size: 111,
        mimeType: "application/pdf",
      },
      {
        id: "3",
        part: "3",
        filename: "inline.png",
        size: 4,
        mimeType: "image/png",
        contentId: "<cid-a@mailmaestro>",
      },
    ],
  });
  assert.deepEqual(rebound.normal[0], {
    ...normal,
    uid: 71,
    uidValidity: "2000",
    part: "2",
    size: 111,
  });
  assert.deepEqual(rebound.inline[0], {
    ...source(),
    uid: 71,
    uidValidity: "2000",
    part: "3",
    size: 4,
  });
});

test("canonical rebind fails closed instead of choosing an ambiguous MIME part", () => {
  const normal: ServerAttachmentSource = {
    folderPath: "Drafts",
    uid: 10,
    uidValidity: "1000",
    part: "2",
    filename: "duplicate.pdf",
    size: 10,
    mimeType: "application/pdf",
  };
  assert.throws(
    () =>
      rebindServerSourcesFromCanonicalParts({
        canonicalRef: { folderPath: "Drafts", uid: 71, uidValidity: "2000" },
        normal: [normal],
        inline: [],
        parts: [
          { ...normal, id: "3", part: "3" },
          { ...normal, id: "4", part: "4" },
        ],
      }),
    /DRAFT_ATTACHMENT_SOURCE_NOT_FOUND/,
  );
});
