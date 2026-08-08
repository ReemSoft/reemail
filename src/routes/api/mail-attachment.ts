import { createFileRoute } from "@tanstack/react-router";

/**
 * Streams an email attachment from the private Bridge to the browser.
 *
 * Security model (closes bridge_passthrough_open):
 *   * Requires a signed Mail Session JWT — accountId/companyId come from
 *     verified claims, not the request body.
 *   * IMAP host/port/security are loaded from the database; the browser
 *     cannot influence which host is contacted.
 */
export const Route = createFileRoute("/api/mail-attachment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        const candidate = body as Record<string, unknown> | null;
        if (
          !candidate ||
          typeof candidate !== "object" ||
          typeof candidate.mailSessionToken !== "string" ||
          typeof candidate.password !== "string" ||
          typeof candidate.folder !== "string" ||
          typeof candidate.uid !== "number" ||
          typeof candidate.part !== "string"
        ) {
          return json({ error: "Invalid payload" }, 400);
        }
        const payload = candidate as {
          mailSessionToken: string;
          password: string;
          folder: string;
          uid: number;
          part: string;
        };

        const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
        const auth = await resolveBridgeAuth(payload.mailSessionToken);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const upstream = await fetch(`${auth.bridgeUrl}/api/attachment`, {
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
            part: payload.part,
          }),
        });

        const outHeaders = new Headers();
        const ct = upstream.headers.get("Content-Type");
        const cd = upstream.headers.get("Content-Disposition");
        const cl = upstream.headers.get("Content-Length");
        if (ct) outHeaders.set("Content-Type", ct);
        if (cd) outHeaders.set("Content-Disposition", cd);
        if (cl) outHeaders.set("Content-Length", cl);
        outHeaders.set("X-Content-Type-Options", "nosniff");
        outHeaders.set("Cache-Control", "private, no-store");

        // Stream body straight through — ReadableStream passthrough on Workers.
        return new Response(upstream.body, {
          status: upstream.status,
          headers: outHeaders,
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
