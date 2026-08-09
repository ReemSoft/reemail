import { mailPerf } from "./mail-performance";

export type StagedAttachmentKind = "attachment" | "inline-image";

export interface StagedAttachmentResult {
  handle: string;
  filename: string;
  size: number;
  mimeType: string;
  kind: StagedAttachmentKind;
  expiresAt: number;
}

export async function uploadAttachmentDirect(
  file: File,
  options: {
    mailSessionToken: string;
    kind: StagedAttachmentKind;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  },
): Promise<StagedAttachmentResult> {
  const ticketStartedAt = performance.now();
  const ticketResponse = await fetch("/api/mail-attachment-upload-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      mailSessionToken: options.mailSessionToken,
      filename: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      kind: options.kind,
    }),
  });
  const ticket = await ticketResponse.json().catch(() => null);
  if (!ticketResponse.ok || !ticket?.ok) {
    throw new Error(ticket?.error || "UPLOAD_TICKET_FAILED");
  }
  const ticketMs = performance.now() - ticketStartedAt;

  return new Promise<StagedAttachmentResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.open("POST", ticket.uploadUrl);
    xhr.setRequestHeader("Authorization", `Bearer ${ticket.ticket}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      cleanup();
      try {
        const result = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300 && result.ok) {
          const xhrMs = performance.now() - xhrStartedAt;
          const bridgeStageHeader = xhr.getResponseHeader("X-MailMaestro-Stage-Ms");
          const bridgeStageMs = bridgeStageHeader === null ? Number.NaN : Number(bridgeStageHeader);
          mailPerf("attachment-upload", {
            ticketMs: Math.round(ticketMs),
            xhrMs: Math.round(xhrMs),
            bridgeStageMs: Number.isFinite(bridgeStageMs) ? Math.round(bridgeStageMs) : -1,
            transportApproxMs: Number.isFinite(bridgeStageMs)
              ? Math.max(0, Math.round(xhrMs - bridgeStageMs))
              : -1,
            bytes: file.size,
          });
          resolve(result);
        } else reject(new Error(result.error || `UPLOAD_HTTP_${xhr.status}`));
      } catch {
        reject(new Error(`UPLOAD_HTTP_${xhr.status}`));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("UPLOAD_NETWORK_ERROR"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload aborted", "AbortError"));
    };
    const xhrStartedAt = performance.now();
    try {
      xhr.send(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
