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

  return new Promise<StagedAttachmentResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
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
      options.signal?.removeEventListener("abort", abort);
      try {
        const result = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300 && result.ok) resolve(result);
        else reject(new Error(result.error || `UPLOAD_HTTP_${xhr.status}`));
      } catch {
        reject(new Error(`UPLOAD_HTTP_${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("UPLOAD_NETWORK_ERROR"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.send(file);
  });
}
