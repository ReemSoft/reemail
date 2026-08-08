import assert from "node:assert/strict";
import test from "node:test";
import { mapUploadedAttachments } from "../src/inline-images.js";
import { buildMime } from "../src/smtp.js";
import { draftMimePayload } from "../src/drafts.js";

const id = "0123456789abcdef0123456789abcdef";
const filename = `mm-inline-${id}.png`;
const cid = `mm-inline-${id}@mailmaestro`;

test("maps only matching uploads to CID inline attachments", async () => {
  const mapped = await mapUploadedAttachments(
    [
      { originalname: "normal.txt", path: "/tmp/normal", mimetype: "text/plain", size: 4 },
      { originalname: filename, path: "/tmp/image", mimetype: "image/png", size: 20 },
    ],
    [{ uploadFilename: filename, cid, contentType: "image/png" }],
    async () => Buffer.from("89504e470d0a1a0a", "hex"),
  );
  assert.equal(mapped[0].contentDisposition, undefined);
  assert.equal(mapped[1].cid, cid);
  assert.equal(mapped[1].contentDisposition, "inline");
});

test("rejects unsupported MIME, malformed CID, mismatches and duplicate metadata", async () => {
  const file = [
    { originalname: filename, path: "/tmp/image", mimetype: "image/svg+xml", size: 20 },
  ];
  await assert.rejects(() =>
    mapUploadedAttachments(
      file,
      [{ uploadFilename: filename, cid, contentType: "image/png" }],
      async () => Buffer.from("<svg"),
    ),
  );
  await assert.rejects(() =>
    mapUploadedAttachments([], [{ uploadFilename: filename, cid, contentType: "image/png" }]),
  );
  await assert.rejects(() =>
    mapUploadedAttachments(
      [
        { originalname: filename, path: "/tmp/one", mimetype: "image/png", size: 20 },
        { originalname: filename, path: "/tmp/two", mimetype: "image/png", size: 20 },
      ],
      [{ uploadFilename: filename, cid, contentType: "image/png" }],
    ),
  );
  await assert.rejects(() =>
    mapUploadedAttachments(
      [],
      [{ uploadFilename: filename, cid: "bad\r\n", contentType: "image/png" }],
    ),
  );
  await assert.rejects(() =>
    mapUploadedAttachments(
      [],
      [
        { uploadFilename: filename, cid, contentType: "image/png" },
        { uploadFilename: filename, cid, contentType: "image/png" },
      ],
    ),
  );
});

test("MailComposer emits Content-ID and inline disposition", async () => {
  const { raw } = await buildMime({
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ name: "Receiver", email: "receiver@example.com" }],
    subject: "inline",
    bodyHtml: `<img src="cid:${cid}">`,
    attachments: [
      {
        filename,
        content: Buffer.from("png"),
        contentType: "image/png",
        cid,
        contentDisposition: "inline",
      },
    ],
  });
  const mime = raw.toString("utf8");
  assert.match(mime, new RegExp(`Content-ID: <${cid}>`, "i"));
  assert.match(mime, /Content-Disposition: inline/i);
});

test("1.8 MiB Composer CID stays inline while a normal attachment stays attachment", async () => {
  const large = Buffer.alloc(Math.round(1.8 * 1024 * 1024), 0x61);
  Buffer.from("89504e470d0a1a0a", "hex").copy(large, 0);
  const mapped = await mapUploadedAttachments(
    [
      {
        originalname: filename,
        path: "/tmp/large-inline",
        mimetype: "image/png",
        size: large.length,
      },
      {
        originalname: "document.pdf",
        path: "/tmp/document",
        mimetype: "application/pdf",
        size: 3,
      },
    ],
    [{ uploadFilename: filename, cid, contentType: "image/png" }],
    async (path) => (path.endsWith("large-inline") ? large : Buffer.from("pdf")),
  );
  const { raw } = await buildMime({
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ name: "Receiver", email: "receiver@example.com" }],
    subject: "large inline",
    bodyHtml: `<p>text</p><img src="cid:${cid}">`,
    attachments: mapped.map(({ path: _path, ...attachment }) => ({
      ...attachment,
      content: attachment.filename === filename ? large : Buffer.from("pdf"),
    })),
  });
  const mime = raw.toString("utf8");
  const decodedHtml = mime.replace(/=\r\n/g, "").replace(/=3D/gi, "=");
  assert.ok(decodedHtml.includes(`<img src="cid:${cid}">`));
  assert.ok(new RegExp(`Content-ID: <${cid}>`, "i").test(mime));
  assert.ok(new RegExp(`Content-Disposition: inline;[\\s\\S]{0,120}${filename}`, "i").test(mime));
  assert.ok(/Content-Disposition: attachment;[\s\S]{0,120}document\.pdf/i.test(mime));
});

test("remote draft MIME preserves the CID attachment for later edit/send", async () => {
  const payload = draftMimePayload({
    account: {
      email_address: "sender@example.com",
      display_name: "Sender",
      imap_host: "imap.example.com",
      imap_port: 993,
      imap_secure: true,
      smtp_host: "smtp.example.com",
      smtp_port: 465,
      smtp_secure: true,
    },
    password: "secret",
    draftId: "01234567-89ab-cdef-0123-456789abcdef",
    to: [{ name: "Receiver", email: "receiver@example.com" }],
    cc: [],
    bcc: [],
    subject: "draft",
    bodyHtml: `<img src="cid:${cid}">`,
    inlineImages: [{ uploadFilename: filename, cid, contentType: "image/png" }],
    attachments: [
      {
        filename,
        content: Buffer.from("png"),
        contentType: "image/png",
        cid,
        contentDisposition: "inline",
      },
    ],
  });
  const { raw } = await buildMime(payload);
  const mime = raw.toString("utf8");
  assert.match(mime, new RegExp(`cid:${cid}`, "i"));
  assert.match(mime, new RegExp(`Content-ID: <${cid}>`, "i"));
  assert.doesNotMatch(mime, /Content-Disposition: attachment/i);
});
