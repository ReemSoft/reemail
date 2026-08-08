export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const INLINE_IMAGE_MIN_WIDTH = 40;

export type InlineImageMime = (typeof INLINE_IMAGE_TYPES)[number];

export interface InlineComposeImage {
  id: string;
  cid: string;
  file: File;
  objectUrl: string;
  mimeType: InlineImageMime;
  filename: string;
  uploadFilename: string;
}

export interface InlineImageMetadata {
  id: string;
  cid: string;
  mimeType: InlineImageMime;
  filename: string;
  uploadFilename: string;
}

export type InlineImageValidation =
  | { ok: true; mimeType: InlineImageMime }
  | { ok: false; reason: "type" | "size" };

export function validateInlineImageFile(file: Pick<File, "type" | "size">): InlineImageValidation {
  if (!INLINE_IMAGE_TYPES.includes(file.type as InlineImageMime))
    return { ok: false, reason: "type" };
  if (file.size > INLINE_IMAGE_MAX_BYTES) return { ok: false, reason: "size" };
  return { ok: true, mimeType: file.type as InlineImageMime };
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function createInlineComposeImage(file: File): InlineComposeImage {
  const valid = validateInlineImageFile(file);
  if (!valid.ok)
    throw new Error(valid.reason === "size" ? "INLINE_IMAGE_TOO_LARGE" : "INLINE_IMAGE_TYPE");
  const id = randomId();
  const extension: Record<InlineImageMime, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return {
    id,
    cid: `mm-inline-${id}@mailmaestro`,
    file,
    objectUrl: URL.createObjectURL(file),
    mimeType: valid.mimeType,
    filename: file.name || `inline-image.${extension[valid.mimeType]}`,
    uploadFilename: `mm-inline-${id}.${extension[valid.mimeType]}`,
  };
}

export function hydrateInlineComposeImage(
  file: File,
  metadata: InlineImageMetadata,
): InlineComposeImage {
  const valid = validateInlineImageFile(file);
  if (!valid.ok || valid.mimeType !== metadata.mimeType) throw new Error("INLINE_IMAGE_TYPE");
  return { ...metadata, file, objectUrl: URL.createObjectURL(file) };
}

export function dataUriToFile(dataUri: string, filename: string, mimeType: InlineImageMime): File {
  const prefix = `data:${mimeType};base64,`;
  if (!dataUri.startsWith(prefix)) throw new Error("INLINE_IMAGE_DATA");
  const bytes = Uint8Array.from(atob(dataUri.slice(prefix.length)), (char) => char.charCodeAt(0));
  return new File([bytes], filename, { type: mimeType });
}

export function toInlineImageMetadata(image: InlineComposeImage): InlineImageMetadata {
  const { id, cid, mimeType, filename, uploadFilename } = image;
  return { id, cid, mimeType, filename, uploadFilename };
}

export function restoreRangeOrEnd(editor: HTMLElement, range: Range | null): Range {
  const restored = document.createRange();
  if (range && editor.contains(range.commonAncestorContainer)) {
    restored.setStart(range.startContainer, range.startOffset);
    restored.setEnd(range.endContainer, range.endOffset);
  } else {
    restored.selectNodeContents(editor);
    restored.collapse(false);
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(restored);
  return restored;
}

export function insertInlineImageNode(
  editor: HTMLElement,
  image: InlineComposeImage,
  savedRange: Range | null,
): HTMLImageElement {
  const range = restoreRangeOrEnd(editor, savedRange);
  range.deleteContents();
  const img = document.createElement("img");
  img.src = image.objectUrl;
  img.alt = image.filename;
  img.dataset.mmInlineId = image.id;
  img.draggable = false;
  img.style.maxWidth = "100%";
  img.style.height = "auto";
  img.style.touchAction = "none";
  range.insertNode(img);
  range.setStartAfter(img);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return img;
}

export function clampInlineImageWidth(width: number, editorWidth: number): number {
  return Math.round(
    Math.min(
      Math.max(INLINE_IMAGE_MIN_WIDTH, width),
      Math.max(INLINE_IMAGE_MIN_WIDTH, editorWidth),
    ),
  );
}

export function moveInlineImageNode(
  image: HTMLImageElement,
  marker: HTMLElement,
  editor: HTMLElement,
): void {
  image.remove();
  marker.replaceWith(image);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function removeInlineImageNode(image: HTMLImageElement, editor: HTMLElement): void {
  image.remove();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function findInlineImageNodeByCid(
  editor: HTMLElement,
  cid: string,
): HTMLImageElement | null {
  const wanted = cid.trim().replace(/^<|>$/g, "").toLowerCase();
  return (
    Array.from(editor.querySelectorAll<HTMLImageElement>('img[src^="cid:"]')).find(
      (image) =>
        image.getAttribute("src")?.slice(4).trim().replace(/^<|>$/g, "").toLowerCase() === wanted,
    ) ?? null
  );
}

/** Produce recipient-safe HTML and a bounded metadata list. */
export function serializeInlineImages(
  html: string,
  images: readonly InlineComposeImage[],
  options: { keepEditorIds?: boolean } = {},
): { html: string; inlineImages: InlineImageMetadata[] } {
  const root = document.createElement("div");
  root.innerHTML = html;
  const byId = new Map(images.map((image) => [image.id, image]));
  const used: InlineComposeImage[] = [];
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-mm-inline-id]")) {
    const id = img.dataset.mmInlineId || "";
    const image = byId.get(id);
    if (!image) {
      img.remove();
      continue;
    }
    img.src = `cid:${image.cid}`;
    const measured = Number.parseInt(img.style.width || img.getAttribute("width") || "", 10);
    if (Number.isFinite(measured) && measured >= INLINE_IMAGE_MIN_WIDTH) {
      img.width = measured;
      img.style.width = `${measured}px`;
    }
    img.style.maxWidth = "100%";
    img.style.height = "auto";
    img.removeAttribute("draggable");
    img.style.removeProperty("touch-action");
    if (!options.keepEditorIds) delete img.dataset.mmInlineId;
    used.push(image);
  }
  for (const unsafe of root.querySelectorAll<HTMLImageElement>(
    'img[src^="blob:"],img[src^="data:"]',
  ))
    unsafe.remove();
  for (const node of root.querySelectorAll<HTMLElement>(
    "[data-mm-image-tool],[data-mm-drop-marker]",
  ))
    node.remove();
  return { html: root.innerHTML, inlineImages: used.map(toInlineImageMetadata) };
}

export function metadataToTransport(images: readonly InlineComposeImage[]) {
  return images.map(({ uploadFilename, cid, mimeType }) => ({
    uploadFilename,
    cid,
    contentType: mimeType,
  }));
}
