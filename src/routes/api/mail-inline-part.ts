import { createFileRoute } from "@tanstack/react-router";

const INLINE_PART_MAX_BYTES = 5 * 1024 * 1024;
const FOLDERS = new Set(["inbox", "starred", "sent", "drafts", "spam", "trash", "archive", "all"]);
const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

interface InlinePartRequest {
  mailSessionToken: string;
  password: string;
  folder: string;
  uid: number;
  uidValidity: string;
  part?: string;
  parts?: Array<{ cid: string; part: string; mimeType: string; size: number }>;
}

export function parseInlinePartRequest(value: unknown): InlinePartRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "mailSessionToken",
    "password",
    "folder",
    "uid",
    "uidValidity",
    "part",
    "parts",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return null;
  if (
    typeof candidate.mailSessionToken !== "string" ||
    !candidate.mailSessionToken ||
    typeof candidate.password !== "string" ||
    !candidate.password ||
    typeof candidate.folder !== "string" ||
    !FOLDERS.has(candidate.folder) ||
    !Number.isInteger(candidate.uid) ||
    Number(candidate.uid) <= 0 ||
    typeof candidate.uidValidity !== "string" ||
    !/^[1-9]\d*$/.test(candidate.uidValidity) ||
    candidate.uidValidity.length > 64
  ) {
    return null;
  }
  const singleValid = typeof candidate.part === "string" && /^\d+(?:\.\d+)*$/.test(candidate.part);
  const parts = Array.isArray(candidate.parts) ? candidate.parts : null;
  const batchValid =
    parts !== null &&
    parts.length > 0 &&
    parts.length <= 20 &&
    parts.every(
      (part) =>
        part &&
        typeof part === "object" &&
        typeof part.cid === "string" &&
        part.cid.length > 0 &&
        part.cid.length <= 998 &&
        typeof part.part === "string" &&
        /^\d+(?:\.\d+)*$/.test(part.part) &&
        typeof part.mimeType === "string" &&
        INLINE_MIMES.has(part.mimeType.split(";", 1)[0].trim().toLowerCase()) &&
        Number.isInteger(part.size) &&
        part.size >= 0 &&
        part.size <= INLINE_PART_MAX_BYTES,
    ) &&
    parts.reduce((total, part) => total + part.size, 0) <= 25 * 1024 * 1024;
  if (singleValid === batchValid) return null;
  return candidate as unknown as InlinePartRequest;
}

export const Route = createFileRoute("/api/mail-inline-part")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        const payload = parseInlinePartRequest(body);
        if (!payload) return json({ error: "Invalid payload" }, 400);

        const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
        const auth = await resolveBridgeAuth(payload.mailSessionToken);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let upstream: Response;
        try {
          const batch = payload.parts !== undefined;
          upstream = await fetch(
            `${auth.bridgeUrl}${batch ? "/api/message-inline-parts" : "/api/message-inline-part"}`,
            {
              method: "POST",
              signal: request.signal,
              headers: {
                "Content-Type": "application/json",
                "X-Bridge-Key": auth.bridgeKey,
              },
              body: JSON.stringify({
                account: auth.bridgeAccount,
                password: payload.password,
                folder: payload.folder,
                uid: payload.uid,
                expectedUidValidity: payload.uidValidity,
                ...(batch ? { parts: payload.parts } : { part: payload.part }),
              }),
            },
          );
        } catch (error) {
          // Client navigated away / cancelled the image request: not a server fault.
          if (request.signal.aborted || (error as Error)?.name === "AbortError") {
            return json({ error: "Request aborted" }, 499);
          }
          return json({ error: "Inline image unavailable" }, 502);
        }
        if (!upstream.ok) {
          await upstream.body?.cancel().catch(() => undefined);
          return json({ error: "Inline image unavailable" }, upstream.status);
        }

        const rawContentType = upstream.headers.get("Content-Type") ?? "";
        if (payload.parts) {
          const contentLength = upstream.headers.get("Content-Length");
          const declaredBytes = contentLength === null ? null : Number(contentLength);
          if (
            !/^multipart\/form-data;\s*boundary=[a-z0-9-]+$/i.test(rawContentType) ||
            (declaredBytes !== null &&
              (!Number.isInteger(declaredBytes) ||
                declaredBytes <= 0 ||
                declaredBytes > 34 * 1024 * 1024))
          ) {
            await upstream.body?.cancel().catch(() => undefined);
            return json({ error: "Invalid inline image batch" }, 502);
          }
          return new Response(upstream.body, {
            status: 200,
            headers: {
              "Content-Type": rawContentType,
              ...(declaredBytes === null ? {} : { "Content-Length": String(declaredBytes) }),
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
            },
          });
        }
        const mimeType = rawContentType.split(";", 1)[0].trim().toLowerCase();
        const contentLength = upstream.headers.get("Content-Length");
        const declaredBytes = contentLength === null ? null : Number(contentLength);
        if (!INLINE_MIMES.has(mimeType)) {
          await upstream.body?.cancel().catch(() => undefined);
          return json({ error: "Unsafe inline image MIME" }, 415);
        }
        if (
          declaredBytes !== null &&
          (!Number.isInteger(declaredBytes) ||
            declaredBytes <= 0 ||
            declaredBytes > INLINE_PART_MAX_BYTES)
        ) {
          await upstream.body?.cancel().catch(() => undefined);
          return json({ error: "Invalid inline image size" }, 413);
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            ...(declaredBytes === null ? {} : { "Content-Length": String(declaredBytes) }),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
          },
        });
      },
    },
  },
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
