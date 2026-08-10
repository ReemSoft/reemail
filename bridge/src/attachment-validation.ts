export type AttachmentValidationFailure =
  | "NORMAL_ATTACHMENT_KIND_MISMATCH"
  | "INLINE_ATTACHMENT_KIND_MISMATCH"
  | "INLINE_ATTACHMENT_FILENAME_MISMATCH";

export interface ResolvedAttachmentDescriptor {
  kind: "attachment" | "inline-image";
  filename: string;
}

export function classifyAttachmentValidationFailure(
  normal: readonly ResolvedAttachmentDescriptor[],
  inline: readonly {
    item: { uploadFilename?: string };
    staged: ResolvedAttachmentDescriptor;
  }[],
): AttachmentValidationFailure | null {
  if (normal.some((item) => item.kind !== "attachment")) return "NORMAL_ATTACHMENT_KIND_MISMATCH";
  if (inline.some(({ staged }) => staged.kind !== "inline-image"))
    return "INLINE_ATTACHMENT_KIND_MISMATCH";
  if (inline.some(({ item, staged }) => staged.filename !== item.uploadFilename))
    return "INLINE_ATTACHMENT_FILENAME_MISMATCH";
  return null;
}
