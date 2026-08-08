// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  alignInlineImageNode,
  clampInlineImageWidth,
  createInlineComposeImage,
  insertInlineImageNode,
  moveInlineImageNode,
  removeInlineImageNode,
  resolveInlineImageDropTarget,
  serializeInlineImages,
  startInlineImageDragSession,
  validateInlineImageFile,
  type InlineImageDragSession,
} from "../mail-compose-inline-images";
import { InlineUploadMetadataSchema } from "../mail-inline-upload-metadata";

describe("composer inline images", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setRect(
    element: Element,
    { left = 0, top = 0, width = 600, height = 40 }: Partial<DOMRect> = {},
  ) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
  }

  function setNativeCaret(range: Range | null) {
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => range),
    });
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: vi.fn(() => null),
    });
  }

  function createDropEditor() {
    const editor = document.createElement("div");
    const first = document.createElement("p");
    const second = document.createElement("p");
    const image = document.createElement("img");
    first.textContent = "first";
    second.textContent = "second";
    image.src = "blob:preview";
    image.dataset.mmInlineId = "same-id";
    editor.append(first, image, second);
    document.body.append(editor);
    setRect(editor, { left: 100, top: 100, width: 600, height: 500 });
    setRect(first, { left: 100, top: 120, width: 600, height: 40 });
    setRect(image, { left: 100, top: 170, width: 200, height: 100 });
    setRect(second, { left: 100, top: 300, width: 600, height: 40 });
    return { editor, first, second, image };
  }

  function applyDrop(
    editor: HTMLElement,
    image: HTMLImageElement,
    clientX: number,
    clientY: number,
  ) {
    const target = resolveInlineImageDropTarget(editor, image, clientX, clientY);
    const marker = document.createElement("span");
    marker.dataset.mmDropMarker = "1";
    target.range.insertNode(marker);
    moveInlineImageNode(image, marker, editor, target.alignment);
    return target;
  }

  function pointer(
    type: string,
    { clientX, clientY, pointerId = 7 }: { clientX: number; clientY: number; pointerId?: number },
  ) {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX,
      clientY,
      isPrimary: true,
      pointerId,
      pointerType: "mouse",
    });
  }

  function createGestureHarness() {
    const { editor, first, second, image } = createDropEditor();
    const wrap = document.createElement("div");
    const surface = document.createElement("button");
    surface.dataset.mmImageTool = "1";
    surface.dataset.mmImageDragSurface = "1";
    editor.replaceWith(wrap);
    wrap.append(editor, surface);
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(surface, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });
    let session: InlineImageDragSession | null = null;
    let commits = 0;
    surface.addEventListener("pointerdown", (event) => {
      session = startInlineImageDragSession(event, {
        editor,
        image,
        surface,
        onCommit: () => commits++,
      });
    });
    return {
      editor,
      first,
      second,
      image,
      surface,
      wrap,
      setPointerCapture,
      releasePointerCapture,
      getSession: () => session,
      getCommits: () => commits,
    };
  }

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

  it("uses a valid native caret target and moves the same image there", () => {
    const { editor, first, image } = createDropEditor();
    const range = document.createRange();
    range.setStart(first.firstChild!, 2);
    range.collapse(true);
    setNativeCaret(range);
    const target = applyDrop(editor, image, 200, 130);
    expect(target.usedFallback).toBe(false);
    expect(first.childNodes[1]).toBe(image);
    expect(image.dataset.mmInlineId).toBe("same-id");
  });

  it("falls back to the editor end when native caret lookup is null in blank space", () => {
    const { editor, second, image } = createDropEditor();
    setNativeCaret(null);
    const target = applyDrop(editor, image, 400, 580);
    expect(target.usedFallback).toBe(true);
    expect(editor.lastElementChild?.contains(image)).toBe(true);
    expect(second.nextElementSibling).toBe(editor.lastElementChild);
  });

  it("falls back before the first content block above the editor content", () => {
    const { editor, first, image } = createDropEditor();
    setNativeCaret(null);
    applyDrop(editor, image, 150, 105);
    expect(editor.firstElementChild?.contains(image)).toBe(true);
    expect(editor.firstElementChild?.nextElementSibling).toBe(first);
  });

  it("falls back to the nearest boundary between top-level blocks", () => {
    const { editor, first, second, image } = createDropEditor();
    setNativeCaret(null);
    applyDrop(editor, image, 150, 230);
    expect(first.nextElementSibling?.contains(image)).toBe(true);
    expect(first.nextElementSibling?.nextElementSibling).toBe(second);
  });

  it.each([
    [150, "left"],
    [400, "center"],
    [650, "right"],
  ] as const)("uses physical drop X=%s for %s alignment", (clientX, alignment) => {
    const { editor, image } = createDropEditor();
    setNativeCaret(null);
    applyDrop(editor, image, clientX, 580);
    expect(image.parentElement?.style.textAlign).toBe(alignment);
  });

  it("does not invert physical horizontal thirds in an RTL editor", () => {
    const { editor, image } = createDropEditor();
    editor.dir = "rtl";
    setNativeCaret(null);
    applyDrop(editor, image, 150, 580);
    expect(image.parentElement?.style.textAlign).toBe("left");
  });

  it("aligns a native editor-boundary drop in otherwise empty horizontal space", () => {
    const { editor, image } = createDropEditor();
    const range = document.createRange();
    range.setStart(editor, editor.childNodes.length);
    range.collapse(true);
    setNativeCaret(range);
    const target = applyDrop(editor, image, 650, 580);
    expect(target.usedFallback).toBe(false);
    expect(image.parentElement?.style.textAlign).toBe("right");
  });

  it("preserves image identity, object URL, CID metadata, and resize behavior after moving", () => {
    const { editor, image } = createDropEditor();
    const composeImage = createInlineComposeImage(
      new File(["image"], "identity.png", { type: "image/png" }),
    );
    image.src = composeImage.objectUrl;
    image.dataset.mmInlineId = composeImage.id;
    const originalNode = image;
    const originalMetadata = {
      id: composeImage.id,
      cid: composeImage.cid,
      objectUrl: composeImage.objectUrl,
    };
    setNativeCaret(null);
    applyDrop(editor, image, 400, 580);
    image.style.width = `${clampInlineImageWidth(320, 600)}px`;
    expect(editor.querySelector("img")).toBe(originalNode);
    expect(image.dataset.mmInlineId).toBe(originalMetadata.id);
    expect(image.src).toBe(originalMetadata.objectUrl);
    expect(composeImage.cid).toBe(originalMetadata.cid);
    expect(image.style.width).toBe("320px");
  });

  it("deletes a moved image and its now-empty alignment wrapper", () => {
    const { editor, image } = createDropEditor();
    setNativeCaret(null);
    applyDrop(editor, image, 400, 580);
    const wrapper = image.parentElement!;
    expect(wrapper.dataset.mmInlineWrapper).toBe("1");
    removeInlineImageNode(image, editor);
    expect(editor.contains(wrapper)).toBe(false);
    expect(editor.querySelector("img")).toBeNull();
  });

  it("does not delete meaningful text that was added beside a moved image", () => {
    const { editor, image } = createDropEditor();
    setNativeCaret(null);
    applyDrop(editor, image, 400, 580);
    const wrapper = image.parentElement!;
    wrapper.append("keep me");
    removeInlineImageNode(image, editor);
    expect(editor.contains(wrapper)).toBe(true);
    expect(wrapper.textContent).toBe("keep me");
  });

  it("serializes width and alignment to inert CID HTML without mutating the live blob preview", () => {
    const composeImage = createInlineComposeImage(
      new File(["image"], "aligned.png", { type: "image/png" }),
    );
    const editor = document.createElement("div");
    editor.innerHTML = `<div data-mm-inline-wrapper="1" style="text-align:right"><img src="${composeImage.objectUrl}" data-mm-inline-id="${composeImage.id}" style="width:280px;height:auto"></div>`;
    const before = editor.innerHTML;
    const result = serializeInlineImages(editor.innerHTML, [composeImage]);
    expect(result.html).toMatch(/text-align:\s*right/);
    expect(result.html).toContain('width="280"');
    expect(result.html).toContain(`src="cid:${composeImage.cid}"`);
    expect(result.html).not.toContain("base64");
    expect(editor.innerHTML).toBe(before);
    expect(editor.querySelector("img")?.getAttribute("src")).toBe(composeImage.objectUrl);
  });

  it("rejects native targets inside the dragged image controls and marker", () => {
    const { editor, image } = createDropEditor();
    const controls = document.createElement("span");
    controls.dataset.mmImageTool = "1";
    editor.append(controls);
    const range = document.createRange();
    range.setStart(controls, 0);
    range.collapse(true);
    setNativeCaret(range);
    expect(resolveInlineImageDropTarget(editor, image, 200, 580).usedFallback).toBe(true);
  });

  it("runs the real overlay pointer lifecycle and moves the same node into blank lower space", () => {
    const harness = createGestureHarness();
    let bubbledPointerDown = 0;
    harness.wrap.addEventListener("pointerdown", () => bubbledPointerDown++);
    const originalNode = harness.image;
    const originalId = harness.image.dataset.mmInlineId;
    const originalSrc = harness.image.src;
    const down = pointer("pointerdown", { clientX: 150, clientY: 190 });
    harness.surface.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(bubbledPointerDown).toBe(0);
    expect(harness.getSession()).not.toBeNull();
    expect(harness.setPointerCapture).toHaveBeenCalledWith(7);

    window.dispatchEvent(pointer("pointermove", { clientX: 400, clientY: 580 }));
    const marker = harness.editor.querySelector<HTMLElement>("[data-mm-drop-marker]");
    const ghost = document.body.querySelector<HTMLElement>("[data-mm-image-drag-ghost]");
    expect(marker).not.toBeNull();
    expect(ghost?.style.left).toBe("350px");
    expect(ghost?.style.top).toBe("560px");
    expect(harness.image.parentElement).toBe(harness.editor);

    window.dispatchEvent(pointer("pointerup", { clientX: 400, clientY: 580 }));
    expect(harness.getCommits()).toBe(1);
    expect(harness.editor.querySelector("img")).toBe(originalNode);
    expect(harness.image.dataset.mmInlineId).toBe(originalId);
    expect(harness.image.src).toBe(originalSrc);
    expect(harness.editor.lastElementChild?.contains(harness.image)).toBe(true);
    expect(harness.image.parentElement?.style.textAlign).toBe("center");
    expect(document.body.querySelector("[data-mm-image-drag-ghost]")).toBeNull();
    expect(harness.editor.querySelector("[data-mm-drop-marker]")).toBeNull();
    expect(harness.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it.each([
    [150, "left"],
    [400, "center"],
    [650, "right"],
  ] as const)("commits overlay drag X=%s with %s alignment", (clientX, alignment) => {
    const harness = createGestureHarness();
    harness.surface.dispatchEvent(pointer("pointerdown", { clientX: 150, clientY: 190 }));
    window.dispatchEvent(pointer("pointermove", { clientX, clientY: 580 }));
    window.dispatchEvent(pointer("pointerup", { clientX, clientY: 580 }));
    expect(harness.image.parentElement?.style.textAlign).toBe(alignment);
  });

  it("cancels an overlay drag without moving and removes every transient node", () => {
    const harness = createGestureHarness();
    const originalParent = harness.image.parentElement;
    const originalNext = harness.image.nextSibling;
    harness.surface.dispatchEvent(pointer("pointerdown", { clientX: 150, clientY: 190 }));
    window.dispatchEvent(pointer("pointermove", { clientX: 650, clientY: 580 }));
    expect(document.body.querySelector("[data-mm-image-drag-ghost]")).not.toBeNull();
    window.dispatchEvent(pointer("pointercancel", { clientX: 650, clientY: 580 }));
    expect(harness.getCommits()).toBe(0);
    expect(harness.image.parentElement).toBe(originalParent);
    expect(harness.image.nextSibling).toBe(originalNext);
    expect(harness.image.style.opacity).toBe("");
    expect(document.body.querySelector("[data-mm-image-drag-ghost]")).toBeNull();
    expect(harness.editor.querySelector("[data-mm-drop-marker]")).toBeNull();
  });

  it("keeps resize and delete behavior working after the overlay drag", () => {
    const harness = createGestureHarness();
    harness.surface.dispatchEvent(pointer("pointerdown", { clientX: 150, clientY: 190 }));
    window.dispatchEvent(pointer("pointermove", { clientX: 400, clientY: 580 }));
    window.dispatchEvent(pointer("pointerup", { clientX: 400, clientY: 580 }));
    harness.image.style.width = `${clampInlineImageWidth(360, 600)}px`;
    expect(harness.image.style.width).toBe("360px");
    const wrapper = harness.image.parentElement!;
    removeInlineImageNode(harness.image, harness.editor);
    expect(harness.editor.contains(wrapper)).toBe(false);
    expect(harness.editor.querySelector("img")).toBeNull();
  });

  it.each(["left", "center", "right"] as const)(
    "applies the %s manual alignment control without replacing the image",
    (alignment) => {
      const { editor, image } = createDropEditor();
      const original = image;
      alignInlineImageNode(image, editor, alignment);
      expect(editor.querySelector("img")).toBe(original);
      expect(image.parentElement?.style.textAlign).toBe(alignment);
    },
  );

  it("wires drag only from the overlay and never disables live image pointer events", () => {
    const source = readFileSync("src/routes/mail.tsx", "utf8");
    expect(source).toContain('data-mm-image-drag-surface="1"');
    expect(source).toContain("onPointerDown={startImageDrag}");
    expect(source).not.toContain('editor.addEventListener("pointerdown"');
    expect(source).not.toMatch(/dragImg\.style\.pointerEvents|image\.style\.pointerEvents/);
    expect(source).toMatch(/e\.preventDefault\(\);\s+e\.stopPropagation\(\);/);
    expect(source.match(/data-mm-image-align=/g)).toHaveLength(1);
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
