import { createFileRoute } from "@tanstack/react-router";

/**
 * Streams an email attachment from the Bridge to the browser.
 *
 * Auth model: password stays in the client's sessionStorage and is POSTed
 * here (never persisted server-side, never in the URL). This route forwards
 * to the bridge over the private MAIL_BRIDGE_URL and streams the response
 * body straight back — O(chunk) memory on the Worker, no buffering.
 */
export const Route = createFileRoute("/api/mail-attachment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const bridgeUrl = process.env.MAIL_BRIDGE_URL;
        const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
        if (!bridgeUrl || !bridgeKey) {
          return new Response(JSON.stringify({ error: "Bridge not configured" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        let body: string;
        try {
          const json = await request.json();
          // Minimal shape guard — full validation happens on the bridge.
          if (
            !json ||
            typeof json !== "object" ||
            !json.account ||
            typeof json.password !== "string" ||
            typeof json.folder !== "string" ||
            typeof json.uid !== "number" ||
            typeof json.part !== "string"
          ) {
            return new Response(JSON.stringify({ error: "Invalid payload" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          body = JSON.stringify(json);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const upstream = await fetch(`${bridgeUrl.replace(/\/$/, "")}/api/attachment`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Bridge-Key": bridgeKey,
          },
          body,
        });

        // Passthrough safe headers only (never forward Set-Cookie, Server, etc.).
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
