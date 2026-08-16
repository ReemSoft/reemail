export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const INLINE_IMAGE_MIN_WIDTH = 40;
export const INLINE_IMAGE_WRAPPER_ATTR = "data-mm-inline-wrapper";
export const INLINE_IMAGE_POSITION_ATTR = "data-mm-image-position";
export const INLINE_IMAGE_MAX_VERTICAL_GAP = 1200;

// Mirrors mail-compose-quote's quote blocker: http(s) or protocol-relative
// `//` only. Anything else (javascript:, data:, blob:, filesystem:, relative)
// is never restored.
const BLOCKED_REMOTE_IMAGE_ATTR = "data-mm-remote-image-blocked";
const REMOTE_IMAGE_URL_ATTR = "data-mm-remote-image-url";
const REMOTE_IMAGE_SRC_RE = /^(?:https?:)?\/\/[^\s"'<>]+$/i;

export type InlineImageAlignment = "left" | "center" | "right";

export interface InlineImageDropTarget {
  range: Range;
  alignment: InlineImageAlignment | null;
  usedFallback: boolean;
}

export interface InlineImagePositionTarget {
  range: Range;
  offsetX: number;
  offsetY: number;
  anchorY: number;
  desiredLeft: number;
  desiredTop: number;
}

export interface InlineImageDragSession {
  cancel: () => void;
}

export interface InlineImageDragSessionOptions {
  editor: HTMLElement;
  image: HTMLImageElement;
  onCommit?: (image: HTMLImageElement) => void;
  onCleanup?: () => void;
}

export interface InlineImageSelectionListenerOptions {
  editor: HTMLElement;
  getActiveImage: () => HTMLImageElement | null;
  onSelect: (image: HTMLImageElement) => void;
  onClear: () => void;
  beforeClear?: () => void;
}

export type InlineImageMime = (typeof INLINE_IMAGE_TYPES)[number];

export interface InlineComposeImage {
  id: string;
  cid: string;
  file: File;
  objectUrl: string;
  mimeType: InlineImageMime;
  filename: string;
  uploadFilename: string;
  stagedHandle?: string;
  sourceDescriptor?: InlineImageSourceDescriptor;
}

export interface InlineImageSourceDescriptor {
  folderPath: string;
  uid: number;
  uidValidity: string;
  part: string;
  cid: string;
  mimeType: InlineImageMime;
  filename: string;
  size: number;
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
  // Legacy cached inline images may carry a declared MIME that no longer
  // matches the physical bytes. Sniff the already-decoded bytes and build the
  // File with the canonical actual MIME so staging/send metadata is truthful.
  const actual = sniffInlineImageMime(bytes);
  if (!actual) throw new Error("INLINE_IMAGE_DATA");
  return new File([bytes], filename, { type: actual });
}

/** Canonicalizes a supported raster MIME from at most 12 leading bytes. */
export function sniffInlineImageMime(bytes: Uint8Array): InlineImageMime | null {
  const head = Array.from(bytes.subarray(0, 12));
  const hex = head.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const ascii = String.fromCharCode(...head);
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
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

function nodeElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function isExcludedDropNode(node: Node, image: HTMLImageElement): boolean {
  const element = nodeElement(node);
  if (!element) return false;
  return (
    element === image ||
    image.contains(element) ||
    Boolean(element.closest("[data-mm-image-tool],[data-mm-drop-marker]")) ||
    Boolean(element.closest(`[${INLINE_IMAGE_WRAPPER_ATTR}]`)?.contains(image))
  );
}

function nativeCaretRange(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
    caretPositionFromPoint?: (
      clientX: number,
      clientY: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  const direct = doc.caretRangeFromPoint?.(x, y);
  if (direct) return direct;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

function physicalAlignment(editor: HTMLElement, clientX: number): InlineImageAlignment {
  const rect = editor.getBoundingClientRect();
  const relativeX = Math.max(0, Math.min(rect.width, clientX - rect.left));
  if (relativeX < rect.width / 3) return "left";
  if (relativeX < (rect.width * 2) / 3) return "center";
  return "right";
}

function nodeVerticalBounds(node: Node): { top: number; bottom: number } | null {
  if (node instanceof Element) {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }
  const range = document.createRange();
  range.selectNode(node);
  const rect = range.getBoundingClientRect();
  return rect ? { top: rect.top, bottom: rect.bottom } : null;
}

function isIgnorableWrapperNode(node: Node): boolean {
  return (
    (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) ||
    (node instanceof HTMLElement && node.tagName === "BR")
  );
}

function wrapperContainsOnlyImage(wrapper: HTMLElement, image: HTMLImageElement): boolean {
  return Array.from(wrapper.childNodes).every(
    (node) => node === image || isIgnorableWrapperNode(node),
  );
}

function removeEmptyWrapper(wrapper: HTMLElement | null): void {
  if (wrapper && Array.from(wrapper.childNodes).every(isIgnorableWrapperNode)) wrapper.remove();
}

/** Resolve a native caret first, then a deterministic top-level block boundary. */
export function resolveInlineImageDropTarget(
  editor: HTMLElement,
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): InlineImageDropTarget {
  const native = nativeCaretRange(clientX, clientY);
  if (
    native &&
    editor.contains(native.startContainer) &&
    !isExcludedDropNode(native.startContainer, image)
  ) {
    return {
      range: native,
      alignment: native.startContainer === editor ? physicalAlignment(editor, clientX) : null,
      usedFallback: false,
    };
  }

  return resolveInlineImageBlockDropTarget(editor, image, clientX, clientY);
}

/** Geometry-only drop resolution used by the production pointer gesture. */
export function resolveInlineImageBlockDropTarget(
  editor: HTMLElement,
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
): InlineImageDropTarget {
  const candidates = Array.from(editor.childNodes).flatMap((node, index) => {
    const bounds = nodeVerticalBounds(node);
    return bounds && !isExcludedDropNode(node, image) ? [{ node, index, bounds }] : [];
  });
  let offset = editor.childNodes.length;
  if (candidates.length) {
    const boundaries = [{ offset: candidates[0].index, y: candidates[0].bounds.top }];
    for (let index = 0; index < candidates.length; index += 1) {
      const current = candidates[index];
      const next = candidates[index + 1];
      boundaries.push({
        offset: current.index + 1,
        y: next ? (current.bounds.bottom + next.bounds.top) / 2 : current.bounds.bottom,
      });
    }
    offset = boundaries.reduce((nearest, boundary) =>
      Math.abs(boundary.y - clientY) < Math.abs(nearest.y - clientY) ? boundary : nearest,
    ).offset;
  }
  const range = document.createRange();
  range.setStart(editor, offset);
  range.collapse(true);
  return {
    range,
    alignment: physicalAlignment(editor, clientX),
    usedFallback: true,
  };
}

/** Resolve a logical flow anchor plus continuous physical X/Y offsets. */
export function resolveInlineImagePosition(
  editor: HTMLElement,
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
  pointerOffsetX: number,
  pointerOffsetY: number,
  editorRect = editor.getBoundingClientRect(),
  imageRect = image.getBoundingClientRect(),
): InlineImagePositionTarget {
  const availableWidth = Math.max(0, editorRect.width - imageRect.width);
  const desiredLeft = Math.max(
    0,
    Math.min(availableWidth, clientX - editorRect.left - pointerOffsetX),
  );
  const maxTop = Math.max(editorRect.top, editorRect.bottom - imageRect.height);
  const desiredTop = Math.max(editorRect.top, Math.min(maxTop, clientY - pointerOffsetY));
  const candidates = Array.from(editor.childNodes).flatMap((node, index) => {
    const bounds = nodeVerticalBounds(node);
    return bounds && !isExcludedDropNode(node, image) ? [{ index, bounds }] : [];
  });
  const boundaries = candidates.length
    ? [
        { offset: candidates[0].index, y: editorRect.top },
        ...candidates.map((candidate) => ({
          offset: candidate.index + 1,
          y: candidate.bounds.bottom,
        })),
      ]
    : [{ offset: editor.childNodes.length, y: editorRect.top }];
  const anchor = boundaries.reduce((selected, boundary) =>
    boundary.y <= desiredTop && boundary.y >= selected.y ? boundary : selected,
  );
  const range = document.createRange();
  range.setStart(editor, anchor.offset);
  range.collapse(true);
  return {
    range,
    offsetX: Math.round(desiredLeft),
    offsetY: Math.round(
      Math.max(0, Math.min(INLINE_IMAGE_MAX_VERTICAL_GAP, desiredTop - anchor.y)),
    ),
    anchorY: anchor.y,
    desiredLeft,
    desiredTop,
  };
}

function pointInside(element: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

function createDropMarker(target: InlineImagePositionTarget): HTMLElement {
  const marker = document.createElement("span");
  marker.contentEditable = "false";
  marker.setAttribute("aria-hidden", "true");
  marker.dataset.mmDropMarker = "1";
  marker.dataset.mmPositionX = String(target.offsetX);
  marker.dataset.mmPositionY = String(target.offsetY);
  marker.style.cssText =
    "display:block;height:3px;margin:5px 0;background:#2563eb;box-shadow:0 0 0 1px rgba(255,255,255,.9);pointer-events:none";
  marker.style.marginTop = `${target.offsetY}px`;
  target.range.insertNode(marker);
  return marker;
}

export function isInlineImageToolTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-mm-image-tool="1"]'));
}

export function installInlineImageSelectionListener(
  options: InlineImageSelectionListenerOptions,
): () => void {
  const onPointerDown = (event: PointerEvent) => {
    const activeImage = options.getActiveImage();
    if (!activeImage) return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target === activeImage ||
      (target && activeImage.contains(target)) ||
      isInlineImageToolTarget(target)
    )
      return;
    const nextImage = target?.closest<HTMLImageElement>("img[data-mm-inline-id]") ?? null;
    if (nextImage && options.editor.contains(nextImage)) {
      options.onSelect(nextImage);
      return;
    }
    options.beforeClear?.();
    options.onClear();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  return () => document.removeEventListener("pointerdown", onPointerDown, true);
}

/**
 * Own a complete overlay pointer gesture. The source image remains untouched
 * inside contentEditable until a successful pointerup commits the move.
 */
export function startInlineImageDragSession(
  event: PointerEvent,
  options: InlineImageDragSessionOptions,
): InlineImageDragSession | null {
  if (event.button !== 0 || !event.isPrimary) return null;
  event.preventDefault();
  event.stopPropagation();

  const { editor, image } = options;
  const pointerId = event.pointerId;
  const sourceRect = image.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const offsetX = event.clientX - sourceRect.left;
  const offsetY = event.clientY - sourceRect.top;
  const originalOpacity = image.style.opacity;
  const originalCursor = image.style.cursor;
  const originalBodyUserSelect = document.body.style.userSelect;
  const shield = document.createElement("div");
  shield.dataset.mmImageDragShield = "1";
  shield.setAttribute("aria-hidden", "true");
  shield.style.cssText =
    "position:fixed;inset:0;z-index:2147483646;cursor:grabbing;background:transparent;touch-action:none;user-select:none";
  document.body.append(shield);
  document.body.style.userSelect = "none";
  let started = false;
  let marker: HTMLElement | null = null;
  let ghost: HTMLImageElement | null = null;
  let frame = 0;
  let latestX = event.clientX;
  let latestY = event.clientY;
  let cleaned = false;

  const positionGhost = () => {
    frame = 0;
    if (!ghost) return;
    ghost.style.left = `${latestX - offsetX}px`;
    ghost.style.top = `${latestY - offsetY}px`;
  };
  const updateMarker = (clientX: number, clientY: number) => {
    marker?.remove();
    marker = null;
    if (!pointInside(editor, clientX, clientY)) return;
    marker = createDropMarker(
      resolveInlineImagePosition(
        editor,
        image,
        clientX,
        clientY,
        offsetX,
        offsetY,
        editorRect,
        sourceRect,
      ),
    );
  };
  const beginVisualDrag = () => {
    if (started) return;
    started = true;
    ghost = image.cloneNode(true) as HTMLImageElement;
    delete ghost.dataset.mmInlineId;
    ghost.dataset.mmImageDragGhost = "1";
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.cssText = [
      "position:fixed",
      `left:${sourceRect.left}px`,
      `top:${sourceRect.top}px`,
      `width:${sourceRect.width}px`,
      `height:${sourceRect.height}px`,
      "max-width:none",
      "pointer-events:none",
      "opacity:.75",
      "z-index:2147483647",
      "object-fit:contain",
    ].join(";");
    document.body.append(ghost);
    image.style.opacity = "0.35";
    image.style.cursor = "grabbing";
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    shield.removeEventListener("pointermove", onPointerMove);
    shield.removeEventListener("pointerup", onPointerUp);
    shield.removeEventListener("pointercancel", onPointerCancel);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onWindowBlur);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    marker?.remove();
    marker = null;
    ghost?.remove();
    ghost = null;
    shield.remove();
    image.style.opacity = originalOpacity;
    image.style.cursor = originalCursor;
    document.body.style.userSelect = originalBodyUserSelect;
    options.onCleanup?.();
  };
  const onPointerMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (
      !started &&
      Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) < 4
    )
      return;
    moveEvent.preventDefault();
    beginVisualDrag();
    latestX = moveEvent.clientX;
    latestY = moveEvent.clientY;
    updateMarker(latestX, latestY);
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(positionGhost);
  };
  const onPointerUp = (upEvent: PointerEvent) => {
    if (upEvent.pointerId !== pointerId) return;
    upEvent.preventDefault();
    if (started && pointInside(editor, upEvent.clientX, upEvent.clientY)) {
      marker?.remove();
      marker = null;
      const target = resolveInlineImagePosition(
        editor,
        image,
        upEvent.clientX,
        upEvent.clientY,
        offsetX,
        offsetY,
        editorRect,
        sourceRect,
      );
      marker = createDropMarker(target);
      const committedMarker = marker;
      marker = null;
      positionInlineImageNode(image, committedMarker, editor, target.offsetX, target.offsetY);
      options.onCommit?.(image);
    }
    cleanup();
  };
  const onPointerCancel = (cancelEvent: PointerEvent) => {
    if (cancelEvent.pointerId === pointerId) cleanup();
  };
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") cleanup();
  };
  const onWindowBlur = () => cleanup();

  shield.addEventListener("pointermove", onPointerMove, { passive: false });
  shield.addEventListener("pointerup", onPointerUp);
  shield.addEventListener("pointercancel", onPointerCancel);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onWindowBlur);
  return { cancel: cleanup };
}

function applyPositionStyles(wrapper: HTMLElement, offsetX: number, offsetY: number): void {
  const x = Math.max(0, Math.round(offsetX));
  const y = Math.max(0, Math.min(INLINE_IMAGE_MAX_VERTICAL_GAP, Math.round(offsetY)));
  wrapper.setAttribute(INLINE_IMAGE_WRAPPER_ATTR, "1");
  wrapper.setAttribute(INLINE_IMAGE_POSITION_ATTR, "1");
  wrapper.dataset.mmPositionX = String(x);
  wrapper.dataset.mmPositionY = String(y);
  wrapper.style.display = "block";
  wrapper.style.width = "100%";
  wrapper.style.boxSizing = "border-box";
  wrapper.style.paddingTop = `${y}px`;
  wrapper.style.paddingLeft = `${x}px`;
  wrapper.style.textAlign = "left";
}

export function positionInlineImageNode(
  image: HTMLImageElement,
  marker: HTMLElement,
  editor: HTMLElement,
  offsetX: number,
  offsetY: number,
): void {
  const oldWrapper = image.closest<HTMLElement>(`[${INLINE_IMAGE_WRAPPER_ATTR}]`);
  const wrapper =
    oldWrapper && wrapperContainsOnlyImage(oldWrapper, image)
      ? oldWrapper
      : document.createElement("div");
  applyPositionStyles(wrapper, offsetX, offsetY);
  marker.replaceWith(wrapper);
  if (image.parentElement !== wrapper) wrapper.append(image);
  if (oldWrapper !== wrapper) removeEmptyWrapper(oldWrapper);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function moveInlineImageNode(
  image: HTMLImageElement,
  marker: HTMLElement,
  editor: HTMLElement,
  alignment: InlineImageAlignment | null = null,
): void {
  const oldWrapper = image.closest<HTMLElement>(`[${INLINE_IMAGE_WRAPPER_ATTR}]`);
  if (alignment) {
    const wrapper =
      oldWrapper && wrapperContainsOnlyImage(oldWrapper, image)
        ? oldWrapper
        : document.createElement("div");
    wrapper.setAttribute(INLINE_IMAGE_WRAPPER_ATTR, "1");
    wrapper.style.display = "block";
    wrapper.style.width = "100%";
    wrapper.style.textAlign = alignment;
    marker.replaceWith(wrapper);
    if (image.parentElement !== wrapper) wrapper.append(image);
    if (oldWrapper !== wrapper) removeEmptyWrapper(oldWrapper);
  } else {
    marker.replaceWith(image);
    removeEmptyWrapper(oldWrapper);
  }
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function removeInlineImageNode(image: HTMLImageElement, editor: HTMLElement): void {
  const wrapper = image.closest<HTMLElement>(`[${INLINE_IMAGE_WRAPPER_ATTR}]`);
  if (wrapper && wrapperContainsOnlyImage(wrapper, image)) wrapper.remove();
  else image.remove();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function alignInlineImageNode(
  image: HTMLImageElement,
  editor: HTMLElement,
  alignment: InlineImageAlignment,
): void {
  const oldWrapper = image.closest<HTMLElement>(`[${INLINE_IMAGE_WRAPPER_ATTR}]`);
  let wrapper: HTMLElement;
  if (oldWrapper && wrapperContainsOnlyImage(oldWrapper, image)) {
    wrapper = oldWrapper;
  } else {
    wrapper = document.createElement(image.parentElement === editor ? "div" : "span");
    image.before(wrapper);
    wrapper.append(image);
    removeEmptyWrapper(oldWrapper);
  }
  const editorWidth = editor.getBoundingClientRect().width || editor.clientWidth;
  const imageWidth = image.getBoundingClientRect().width || image.width;
  const availableWidth = Math.max(0, editorWidth - imageWidth);
  const offsetX =
    alignment === "left" ? 0 : alignment === "center" ? availableWidth / 2 : availableWidth;
  const offsetY = Number.parseFloat(wrapper.style.paddingTop) || 0;
  applyPositionStyles(wrapper, offsetX, offsetY);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function findInlineImageNodesByCid(editor: HTMLElement, cid: string): HTMLImageElement[] {
  const wanted = cid.trim().replace(/^<|>$/g, "").toLowerCase();
  return Array.from(
    editor.querySelectorAll<HTMLImageElement>('img[src^="cid:" i],img[data-mm-source-cid]'),
  ).filter((image) => {
    const pending = image.dataset.mmSourceCid;
    const source = pending ?? image.getAttribute("src")?.slice(4) ?? "";
    return source.trim().replace(/^<|>$/g, "").toLowerCase() === wanted;
  });
}

export function findInlineImageNodeByCid(
  editor: HTMLElement,
  cid: string,
): HTMLImageElement | null {
  return findInlineImageNodesByCid(editor, cid)[0] ?? null;
}

export function applyInlineImageToCidNodes(
  editor: HTMLElement,
  sourceCid: string,
  image: InlineComposeImage,
): number {
  const nodes = findInlineImageNodesByCid(editor, sourceCid);
  for (const node of nodes) {
    node.src = image.objectUrl;
    node.dataset.mmInlineId = image.id;
    delete node.dataset.mmSourceCid;
    node.removeAttribute("aria-busy");
    node.style.removeProperty("visibility");
    node.draggable = false;
    node.style.maxWidth = "100%";
    node.style.height = "auto";
  }
  return nodes.length;
}

export function applyInlineImageToCidNode(
  editor: HTMLElement,
  sourceCid: string,
  image: InlineComposeImage,
): boolean {
  return applyInlineImageToCidNodes(editor, sourceCid, image) > 0;
}

/** Produce recipient-safe HTML and a bounded metadata list. */
export function serializeInlineImages(
  html: string,
  images: readonly InlineComposeImage[],
  options: { keepEditorIds?: boolean } = {},
): { html: string; inlineImages: InlineImageMetadata[] } {
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  const byId = new Map(images.map((image) => [image.id, image]));
  const used: InlineComposeImage[] = [];
  const usedIds = new Set<string>();
  const serializedNodes = new Set<HTMLImageElement>();
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-mm-inline-id]")) {
    const id = img.dataset.mmInlineId || "";
    const image = byId.get(id);
    if (!image) {
      img.remove();
      continue;
    }
    img.setAttribute("src", `cid:${image.cid}`);
    delete img.dataset.mmSourceCid;
    img.removeAttribute("aria-busy");
    img.style.removeProperty("visibility");
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
    if (!usedIds.has(image.id)) {
      used.push(image);
      usedIds.add(image.id);
    }
    serializedNodes.add(img);
  }
  for (const unsafe of root.querySelectorAll<HTMLImageElement>(
    'img[src^="blob:"],img[src^="data:"],img[src^="cid:" i],img[data-mm-source-cid]',
  ))
    if (!serializedNodes.has(unsafe)) unsafe.remove();
  if (!options.keepEditorIds) {
    // Remote images blocked for compose privacy are restored to their original
    // safe URL on this detached copy only; the live Composer never sees it.
    for (const blocked of root.querySelectorAll<HTMLImageElement>(
      `img[${BLOCKED_REMOTE_IMAGE_ATTR}],img[${REMOTE_IMAGE_URL_ATTR}]`,
    )) {
      const url = (blocked.getAttribute(REMOTE_IMAGE_URL_ATTR) ?? "").trim();
      if (!REMOTE_IMAGE_SRC_RE.test(url)) {
        blocked.remove();
        continue;
      }
      blocked.setAttribute("src", url);
      blocked.removeAttribute(REMOTE_IMAGE_URL_ATTR);
      blocked.removeAttribute(BLOCKED_REMOTE_IMAGE_ATTR);
      blocked.removeAttribute("aria-hidden");
      blocked.style.removeProperty("visibility");
    }
    // Fail closed: never emit an <img> with no usable source.
    for (const srcLess of root.querySelectorAll<HTMLImageElement>("img")) {
      if (!srcLess.hasAttribute("src")) srcLess.remove();
    }
  }
  for (const node of root.querySelectorAll<HTMLElement>(
    "[data-mm-image-tool],[data-mm-drop-marker]",
  ))
    node.remove();
  if (!options.keepEditorIds) {
    for (const wrapper of root.querySelectorAll<HTMLElement>(`[${INLINE_IMAGE_WRAPPER_ATTR}]`))
      for (const attribute of [
        INLINE_IMAGE_WRAPPER_ATTR,
        INLINE_IMAGE_POSITION_ATTR,
        "data-mm-position-x",
        "data-mm-position-y",
      ])
        wrapper.removeAttribute(attribute);
  }
  return { html: template.innerHTML, inlineImages: used.map(toInlineImageMetadata) };
}

export function metadataToTransport(images: readonly InlineComposeImage[]) {
  return images.map(({ uploadFilename, cid, mimeType }) => ({
    uploadFilename,
    cid,
    contentType: mimeType,
  }));
}
