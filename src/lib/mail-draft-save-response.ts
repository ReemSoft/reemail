import type { DraftServerRef } from "@/lib/mail-draft-lifecycle";

export type ParsedDraftSaveResponse =
  | {
      kind: "success";
      code?: never;
      reconciled: boolean;
      serverRef?: DraftServerRef;
      sourceAttachmentHandles: unknown[] | null;
      inlineSourceHandles: unknown[] | null;
    }
  | {
      kind: "failure";
      code: string;
      reconciled?: never;
      serverRef?: never;
      sourceAttachmentHandles?: never;
      inlineSourceHandles?: never;
    };

export function parseDraftSaveResponse(
  value: Record<string, unknown> | null,
  responseOk: boolean,
): ParsedDraftSaveResponse {
  if (!value || value.ok !== true) {
    return {
      kind: "failure",
      code: String(value?.code ?? value?.error ?? (responseOk ? "UNKNOWN" : "NETWORK")),
    };
  }

  const sourceAttachmentHandles = Array.isArray(value.sourceAttachmentHandles)
    ? value.sourceAttachmentHandles
    : null;
  const inlineSourceHandles = Array.isArray(value.inlineSourceHandles)
    ? value.inlineSourceHandles
    : null;

  const uid = typeof value.uid === "number" && value.uid > 0 ? value.uid : null;
  const uidValidity = typeof value.uidValidity === "string" ? value.uidValidity : null;
  const folderPath = typeof value.folderPath === "string" ? value.folderPath : null;
  const serverRef =
    uid !== null && uidValidity !== null && folderPath !== null
      ? { folderPath, uid, uidValidity }
      : undefined;

  return {
    kind: "success",
    reconciled: value.reconciled === true,
    serverRef,
    sourceAttachmentHandles,
    inlineSourceHandles,
  };
}
