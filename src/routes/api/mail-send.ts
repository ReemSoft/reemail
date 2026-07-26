import { createFileRoute } from "@tanstack/react-router";

/**
 * Streams a multipart/form-data compose (subject, body, addresses, files)
 * from the browser straight to the Bridge. Password stays in the client's
 * sessionStorage — it travels as a form field on this single request,
 * never persisted server-side.
 *
 * Zero-buffering on the Worker: request.body is a ReadableStream and we
 * hand it to the upstream fetch as-is.
 */
export const Route = createFileRoute("/api/mail-send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const bridgeUrl = process.env.MAIL_BRIDGE_URL;
        const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
        if (!bridgeUrl || !bridgeKey) {
          return new Response(
            JSON.stringify({ ok: false, error: "Bridge not configured" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }

        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
          return new Response(
            JSON.stringify({ ok: false, error: "Expected multipart/form-data" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const upstream = await fetch(
          `${bridgeUrl.replace(/\/$/, "")}/api/send-multipart`,
          {
            method: "POST",
            headers: {
              "Content-Type": contentType,
              "X-Bridge-Key": bridgeKey,
            },
            body: request.body,
            // @ts-expect-error — required by undici/Cloudflare when streaming a body
            duplex: "half",
          },
        );

        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "application/json",
            "Cache-Control": "private, no-store",
          },
        });
      },
    },
  },
});
