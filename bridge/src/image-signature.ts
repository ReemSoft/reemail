/**
 * Shared byte-signature sniffing for inline images.
 *
 * Canonicalizes a supported raster MIME from the leading bytes of an
 * already-in-memory buffer. Constant-time: at most 12 bytes are inspected and
 * no I/O is performed. Returns null when the bytes are not a recognised
 * PNG / JPEG / GIF / WEBP image, so callers can fail closed instead of
 * trusting a (possibly wrong) Content-Type / BODYSTRUCTURE declaration.
 */
export function sniffImageMime(prefix: Uint8Array): string | null {
  const bytes = Buffer.from(prefix.subarray(0, 12));
  const hex = bytes.toString("hex");
  const ascii = bytes.toString("ascii");
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}
