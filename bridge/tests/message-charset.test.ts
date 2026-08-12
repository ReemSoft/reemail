import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeDownloadedText } from "../src/imap.js";

const ARABIC = "مرحبا بكم في Mail Maestro";
const UTF8_ARABIC = Buffer.from(ARABIC, "utf8");
const WINDOWS_1256_ARABIC = Buffer.from(
  "e3d1cdc8c720c8dfe320dded204d61696c204d61657374726f",
  "hex",
);
const ISO_8859_6_ARABIC = Buffer.from("e5d1cdc8c720c8e3e520e1ea204d61696c204d61657374726f", "hex");
const WINDOWS_1252_TEXT = Buffer.from("9348656c6c6f942080", "hex");
const ARABIC_SHORT = "مرحبا بكم في";
const WINDOWS_1256_ARABIC_SHORT = Buffer.from("e3d1cdc8c720c8dfe320dded", "hex");
const ISO_8859_6_ARABIC_SHORT = Buffer.from("e5d1cdc8c720c8e3e520e1ea", "hex");

test("ImapFlow-converted UTF-8 wins over the legacy BODYSTRUCTURE charset", () => {
  assert.equal(decodeDownloadedText(UTF8_ARABIC, "windows-1256", { charset: "utf-8" }), ARABIC);
  assert.equal(decodeDownloadedText(UTF8_ARABIC, "iso-8859-6", { charset: "UTF-8" }), ARABIC);
  assert.equal(
    decodeDownloadedText(Buffer.from("“Hello” €", "utf8"), "windows-1252", {
      charset: "utf-8",
    }),
    "“Hello” €",
  );
});

test("BODYSTRUCTURE-only known legacy charsets decode exact fixed byte vectors", () => {
  assert.equal(decodeDownloadedText(WINDOWS_1256_ARABIC, "windows-1256", undefined), ARABIC);
  assert.equal(decodeDownloadedText(ISO_8859_6_ARABIC, "iso-8859-6", undefined), ARABIC);
  assert.equal(decodeDownloadedText(WINDOWS_1252_TEXT, "windows-1252", undefined), "“Hello” €");
  assert.equal(
    decodeDownloadedText(WINDOWS_1256_ARABIC_SHORT, "windows-1256", undefined),
    ARABIC_SHORT,
  );
  assert.equal(
    decodeDownloadedText(ISO_8859_6_ARABIC_SHORT, "iso-8859-6", undefined),
    ARABIC_SHORT,
  );
});

test("UTF-8, mixed text, ASCII, case, and whitespace stay exact", () => {
  for (const value of ["Hello Mail Maestro", ARABIC, `Hello — ${ARABIC}`]) {
    assert.equal(decodeDownloadedText(Buffer.from(value), "  UtF-8  ", undefined), value);
  }
  assert.equal(
    decodeDownloadedText(Buffer.from("ASCII only"), "US-ASCII", undefined),
    "ASCII only",
  );
});

test("download Content-Type charset supports quoted and unquoted labels", () => {
  assert.equal(
    decodeDownloadedText(WINDOWS_1256_ARABIC, undefined, {
      contentType: 'text/html; charset = "windows-1256"',
    }),
    ARABIC,
  );
  assert.equal(
    decodeDownloadedText(WINDOWS_1252_TEXT, undefined, {
      contentType: "text/plain; charset=windows-1252",
    }),
    "“Hello” €",
  );
});

test("download output charset is authoritative when metadata sources differ", () => {
  assert.equal(
    decodeDownloadedText(Buffer.from("“Hello” €", "utf8"), "windows-1256", {
      contentType: "text/html; charset=windows-1252",
      charset: "utf-8",
    }),
    "“Hello” €",
  );
});

test("absent and unknown charsets deterministically fall back to UTF-8 without throwing", () => {
  assert.equal(decodeDownloadedText(UTF8_ARABIC, undefined, undefined), ARABIC);
  assert.equal(decodeDownloadedText(UTF8_ARABIC, "x-unknown-mail-charset", undefined), ARABIC);
});

test("normal and entire message paths invoke the same one-pass decoder", () => {
  const source = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const normal = source.slice(
    source.indexOf("export async function getMessageBody("),
    source.indexOf("export interface EntireMessageBody"),
  );
  const entire = source.slice(
    source.indexOf("export async function downloadEntireBodyInMailbox("),
    source.indexOf("export async function getEntireMessageBody("),
  );
  assert.equal(normal.match(/decodeDownloadedText\(/g)?.length, 1);
  assert.equal(entire.match(/decodeDownloadedText\(/g)?.length, 1);
  assert.doesNotMatch(normal, /new TextDecoder/);
  assert.doesNotMatch(entire, /new TextDecoder/);
});

test("charset correction changes no request, cache, MIME, attachment, or CID surface", () => {
  const source = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("export function decodeDownloadedText("),
    source.indexOf("/**\n * Downloads one body part."),
  );
  assert.doesNotMatch(helper, /fetchOne|downloadPartBuffer|client\.download|withMessageMailbox/);
  assert.doesNotMatch(helper, /BODY_CACHE_VERSION|collectAttachmentParts|selectInline/);
  assert.equal(helper.match(/decodeText\(/g)?.length, 1);
});

test("legacy decoding is runtime-independent and iconv-lite is an exact direct dependency", () => {
  const source = readFileSync(new URL("../src/imap.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const require = createRequire(import.meta.url);
  const installed = require("iconv-lite/package.json") as { version: string };
  assert.equal(packageJson.dependencies?.["iconv-lite"], "0.7.3");
  assert.equal(installed.version, "0.7.3");
  assert.match(source, /import iconv from "iconv-lite"/);
  assert.doesNotMatch(source, /(?:imapflow|mailparser)\/node_modules\/iconv-lite/);
  assert.match(source, /iconv\.encodingExists\(cs\)/);
  assert.match(source, /iconv\.decode\(buf, cs\)/);
  assert.equal(decodeDownloadedText(WINDOWS_1252_TEXT, "windows-1252", undefined), "“Hello” €");
});
