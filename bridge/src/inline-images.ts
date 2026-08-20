import { z } from "zod";
import { open } from "node:fs/promises";
import type { SendAttachment } from "./smtp.js";
import { normalizeAttachmentFilename } from "./attachment-filename.js";
import { sniffImageMime } from "./image-signature.js";

export const INLINE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const InlineImageMetadataSchema = z
  .array(
    z.object({
      uploadFilename: z.string().regex(/^mm-inline-[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/),
      cid: z.string().regex(/^mm-inline-[a-f0-9]{32}@mailmaestro$/),
      contentType: z.enum(INLINE_IMAGE_MIME_TYPES),
    }),
  )
  .max(50)
  .superRefine((items, ctx) => {
    const names = new Set<string>();
    const cids = new Set<string>();
    for (const item of items) {
      if (names.has(item.uploadFilename) || cids.has(item.cid)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_INLINE_IMAGE" });
      }
      names.add(item.uploadFilename);
      cids.add(item.cid);
    }
  });

export interface UploadedInlineFile {
  originalname: string;
  path: string;
  mimetype: string;
  size: number;
}

async function readFilePrefix(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function mapUploadedAttachments(
  files: UploadedInlineFile[],
  rawMetadata: unknown,
  readPrefix: (path: string) => Promise<Uint8Array> = readFilePrefix,
): Promise<SendAttachment[]> {
  const metadata = InlineImageMetadataSchema.parse(rawMetadata ?? []);
  const byName = new Map(metadata.map((item) => [item.uploadFilename, item]));
  for (const name of byName.keys()) {
    if (files.filter((file) => file.originalname === name).length !== 1) {
      throw new Error("INLINE_IMAGE_FILE_MISMATCH");
    }
  }
  const matched = new Set<string>();
  const attachments = await Promise.all(
    files.map(async (file): Promise<SendAttachment> => {
      const inline = byName.get(file.originalname);
      if (!inline)
        return {
          filename: normalizeAttachmentFilename(file.originalname),
          path: file.path,
          contentType: file.mimetype,
        };
      if (
        file.size > INLINE_IMAGE_MAX_BYTES ||
        file.mimetype !== inline.contentType ||
        (await readPrefix(file.path).then(sniffImageMime)) !== inline.contentType ||
        !INLINE_IMAGE_MIME_TYPES.includes(file.mimetype as (typeof INLINE_IMAGE_MIME_TYPES)[number])
      )
        throw new Error("INVALID_INLINE_IMAGE");
      matched.add(file.originalname);
      return {
        filename: normalizeAttachmentFilename(file.originalname),
        path: file.path,
        contentType: file.mimetype,
        cid: inline.cid,
        contentDisposition: "inline",
      };
    }),
  );
  if (matched.size !== metadata.length) throw new Error("INLINE_IMAGE_FILE_MISMATCH");
  return attachments;
}
