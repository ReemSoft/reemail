export const INLINE_PREVIEW_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export function sanitizeAttachmentFilename(name: string | undefined | null): string {
  if (!name) return "attachment";
  const withoutControls = Array.from(name, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f ? "" : character;
  }).join("");
  const cleaned = withoutControls.replace(/[/\\]/g, "_").trim();
  return cleaned.slice(0, 200) || "attachment";
}

export function attachmentContentDisposition(
  filename: string,
  mimeType: string,
  mode: "download" | "preview" = "preview",
): string {
  const disposition =
    mode === "preview" && INLINE_PREVIEW_MIME_TYPES.has(mimeType.toLowerCase())
      ? "inline"
      : "attachment";
  const asciiSafe = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
