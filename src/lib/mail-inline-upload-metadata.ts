import { z } from "zod";

export const InlineUploadMetadataSchema = z
  .array(
    z.object({
      uploadFilename: z.string().regex(/^mm-inline-[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/),
      cid: z.string().regex(/^mm-inline-[a-f0-9]{32}@mailmaestro$/),
      contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    }),
  )
  .max(20)
  .superRefine((items, ctx) => {
    if (
      new Set(items.map((item) => item.uploadFilename)).size !== items.length ||
      new Set(items.map((item) => item.cid)).size !== items.length
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate inline image metadata" });
    }
  });
