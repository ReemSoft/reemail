// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  clampInlineImageWidth,
  createInlineComposeImage,
  insertInlineImageNode,
  moveInlineImageNode,
  removeInlineImageNode,
  serializeInlineImages,
  validateInlineImageFile,
} from "../mail-compose-inline-images";
import { InlineUploadMetadataSchema } from "../mail-inline-upload-metadata";

describe("composer inline images", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("accepts %s", (type) => {
    expect(validateInlineImageFile({ type, size: 12 })).toEqual({ ok: true, mimeType: type });
  });

  it("rejects SVG, non-images and files over 5 MiB", () => {
    expect(validateInlineImageFile({ type: "image/svg+xml", size: 12 })).toEqual({
      ok: false,
      reason: "type",
    });
    expect(validateInlineImageFile({ type: "text/plain", size: 12 })).toEqual({
      ok: false,
      reason: "type",
    });
    expect(validateInlineImageFile({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toEqual({
      ok: false,
      reason: "size",
    });
  });

  it("inserts exactly one node at the saved caret and falls back to the end", () => {
    const editor = document.createElement("div");
    editor.append("beforeafter");
    document.body.append(editor);
    const range = document.createRange();
    range.setStart(editor.firstChild!, 6);
    range.collapse(true);
    const image = createInlineComposeImage(new File(["x"], "x.png", { type: "image/png" }));
    insertInlineImageNode(editor, image, range);
    expect(editor.querySelectorAll("img")).toHaveLength(1);
    expect(editor.childNodes[1]).toBe(editor.querySelector("img"));
    const second = createInlineComposeImage(new File(["y"], "y.png", { type: "image/png" }));
    insertInlineImageNode(editor, second, null);
    expect(editor.lastChild).toBe(editor.querySelectorAll("img")[1]);
  });

  it("serializes a blob preview to CID, preserves width, and strips editor data", () => {
    const image = createInlineComposeImage(new File(["x"], "x.png", { type: "image/png" }));
    const result = serializeInlineImages(
      `<p>a<img src="blob:preview" data-mm-inline-id="${image.id}" style="width:320px;height:auto" data-extra="x"></p><img src="data:image/png;base64,AA==">`,
      [image],
    );
    expect(result.html).toContain(`src="cid:${image.cid}"`);
    expect(result.html).toContain('width="320"');
    expect(result.html).not.toContain("blob:");
    expect(result.html).not.toContain("data:image");
    expect(result.html).not.toContain("data-mm-inline-id");
    expect(result.inlineImages).toHaveLength(1);
  });

  it("enforces resize minimum and editor maximum", () => {
    expect(clampInlineImageWidth(10, 500)).toBe(40);
    expect(clampInlineImageWidth(900, 500)).toBe(500);
    expect(clampInlineImageWidth(240, 500)).toBe(240);
  });

  it("moves the same node and emits one change, then delete emits one change", () => {
    const editor = document.createElement("div");
    const image = document.createElement("img");
    const marker = document.createElement("span");
    editor.append(image, "middle", marker);
    let changes = 0;
    editor.addEventListener("input", () => changes++);
    moveInlineImageNode(image, marker, editor);
    expect(editor.querySelectorAll("img")).toHaveLength(1);
    expect(editor.lastChild).toBe(image);
    expect(changes).toBe(1);
    removeInlineImageNode(image, editor);
    expect(editor.querySelector("img")).toBeNull();
    expect(changes).toBe(2);
  });

  it("wires one native picker flow without the legacy URL prompt or Base64 reader", () => {
    const source = readFileSync("src/routes/mail.tsx", "utf8");
    const imageHandler = source.slice(
      source.indexOf("function promptImage"),
      source.indexOf("async function insertImageFiles"),
    );
    expect(imageHandler).toContain("imageInputRef.current?.click()");
    expect(imageHandler).not.toContain("window.prompt");
    expect(source).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
    expect(source).not.toContain("readAsDataURL");
    expect(source.match(/ref=\{imageInputRef\}/g)).toHaveLength(1);
  });

  it("accepts only bounded safe server metadata", () => {
    const safe = {
      uploadFilename: "mm-inline-0123456789abcdef0123456789abcdef.png",
      cid: "mm-inline-0123456789abcdef0123456789abcdef@mailmaestro",
      contentType: "image/png",
    };
    expect(InlineUploadMetadataSchema.safeParse([safe]).success).toBe(true);
    expect(InlineUploadMetadataSchema.safeParse([{ ...safe, cid: "bad\r\nBcc:x" }]).success).toBe(
      false,
    );
    expect(
      InlineUploadMetadataSchema.safeParse([{ ...safe, contentType: "image/svg+xml" }]).success,
    ).toBe(false);
    expect(InlineUploadMetadataSchema.safeParse([safe, safe]).success).toBe(false);
    expect(JSON.stringify([safe])).not.toContain("base64");
  });
});
