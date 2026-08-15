import assert from "node:assert/strict";
import { test } from "node:test";
import { sniffImageMime } from "../src/image-signature.js";

test("PNG bytes canonicalize to image/png regardless of declaration", () => {
  assert.equal(sniffImageMime(Buffer.from("89504e470d0a1a0a", "hex")), "image/png");
});

test("JPEG bytes canonicalize to image/jpeg regardless of declaration", () => {
  assert.equal(sniffImageMime(Buffer.from("ffd8ffe000104a464946", "hex")), "image/jpeg");
});

test("GIF87a and GIF89a signatures canonicalize to image/gif", () => {
  assert.equal(sniffImageMime(Buffer.from("GIF87a", "ascii")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("GIF89a", "ascii")), "image/gif");
});

test("WEBP RIFF signature canonicalizes to image/webp", () => {
  const webp = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
  ]);
  assert.equal(sniffImageMime(webp), "image/webp");
});

test("unknown/non-image bytes are never promoted to a valid image MIME", () => {
  assert.equal(sniffImageMime(Buffer.from("not an image at all")), null);
  assert.equal(sniffImageMime(Buffer.from("<svg></svg>")), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(Buffer.from("text/plain bytes")), null);
});

test("only the leading bytes matter (constant-time inspection)", () => {
  const withNoise = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.alloc(1024, 0x7f),
  ]);
  assert.equal(sniffImageMime(withNoise), "image/png");
});
