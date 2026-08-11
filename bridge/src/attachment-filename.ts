const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RFC2231_UTF8_PREFIX = /^utf-8''/i;

function utf8SequenceLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

function countMojibakeMarkers(value: string): number {
  const bytes = Array.from(value, (character) => character.codePointAt(0) ?? 0);
  let count = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const length = utf8SequenceLength(bytes[index]);
    if (
      length > 0 &&
      index + length <= bytes.length &&
      bytes.slice(index + 1, index + length).every((byte) => byte >= 0x80 && byte <= 0xbf)
    ) {
      count += 1;
      index += length - 1;
    }
  }
  return count;
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    const decoded = UTF8_DECODER.decode(bytes);
    return decoded.includes("\uFFFD") ? null : decoded;
  } catch {
    return null;
  }
}

function decodeRfc2231Utf8(value: string): string | null {
  if (!RFC2231_UTF8_PREFIX.test(value)) return null;
  const encoded = value.replace(RFC2231_UTF8_PREFIX, "");
  if (!/%[89a-f][0-9a-f]/i.test(encoded)) return null;

  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%") {
      const pair = encoded.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(pair)) return null;
      bytes.push(Number.parseInt(pair, 16));
      index += 2;
      continue;
    }
    const codePoint = encoded.codePointAt(index);
    if (codePoint === undefined || codePoint > 0x7f) return null;
    bytes.push(codePoint);
  }
  return decodeStrictUtf8(Uint8Array.from(bytes));
}

function repairLatin1Mojibake(value: string): string {
  let current = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const markerCount = countMojibakeMarkers(current);
    if (markerCount === 0) break;
    const codePoints = Array.from(current, (character) => character.codePointAt(0) ?? 0);
    if (codePoints.some((codePoint) => codePoint > 0xff)) break;
    const decoded = decodeStrictUtf8(Uint8Array.from(codePoints));
    if (!decoded || countMojibakeMarkers(decoded) >= markerCount) break;
    current = decoded;
  }
  return current;
}

/** Canonicalize attachment metadata without interpreting it as a filesystem path. */
export function normalizeAttachmentFilename(value: string): string {
  const normalized = value.normalize("NFC");
  const rfc2231 = decodeRfc2231Utf8(normalized);
  return (rfc2231 ?? repairLatin1Mojibake(normalized)).normalize("NFC");
}
