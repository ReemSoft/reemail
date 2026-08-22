import { getMailSession } from "@/lib/mail-session";

export interface DownloadMessageEmlInput {
  folder:
    | "inbox"
    | "starred"
    | "sent"
    | "drafts"
    | "spam"
    | "trash"
    | "archive"
    | "all";
  uid: number;
  uidValidity: string;
}

export async function downloadMessageEml(
  input: DownloadMessageEmlInput,
): Promise<void> {
  const session = getMailSession();
  if (!session) throw new Error("SESSION_REQUIRED");

  const filename = `message-${input.uid}.eml`;

  const response = await fetch("/api/mail-eml-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mailSessionToken: session.mailSessionToken ?? "",
      password: session.password,
      folder: input.folder,
      uid: input.uid,
      uidValidity: input.uidValidity,
      filename,
    }),
  });

  const result = await response.json().catch(() => null);

  if (
    !response.ok ||
    typeof result?.downloadUrl !== "string" ||
    !result.downloadUrl
  ) {
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : "EML_DOWNLOAD_UNAVAILABLE",
    );
  }

  // Browser pulls RFC822 bytes directly from Bridge. They do not pass
  // through the app server, body cache, or message-open pipeline.
  const anchor = document.createElement("a");
  anchor.href = result.downloadUrl;
  anchor.download = filename;
  anchor.rel = "noopener";

  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
