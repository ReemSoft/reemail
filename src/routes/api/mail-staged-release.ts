import { createFileRoute } from "@tanstack/react-router";

// Best-effort staged-handle release proxy. The browser never talks to the
// Bridge directly; this route verifies the Mail Session token, resolves the
// server-owned account config, and forwards the release to the Bridge under
// the server-side key. No password and no IMAP work.
export const Route = createFileRoute("/api/mail-staged-release")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const token = typeof body?.mailSessionToken === "string" ? body.mailSessionToken : "";
          const handles = Array.isArray(body?.handles)
            ? body.handles.filter((h: unknown) => typeof h === "string")
            : [];
          if (!token || handles.length === 0) {
            return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          }
          const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
          const auth = await resolveBridgeAuth(token);
          if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
          let upstream: Response;
          try {
            upstream = await fetch(`${auth.bridgeUrl}/api/staged-release`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Bridge-Key": auth.bridgeKey,
              },
              body: JSON.stringify({
                account: auth.bridgeAccount,
                handles,
              }),
            });
          } catch {
            // Transport failure to the bridge — soft-fail; release is best
            // effort and must never block the UI.
            return json({ ok: false, error: "NETWORK", code: "NETWORK" }, 200);
          }
          const result = await upstream.text();
          const isJson = (upstream.headers.get("content-type") ?? "").includes("application/json");
          if (!isJson || upstream.status >= 500) {
            return json({ ok: false, error: "NETWORK", code: "NETWORK" }, 200);
          }
          return new Response(result, {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
            },
          });
        } catch {
          return json({ ok: false, error: "INVALID_PAYLOAD" }, 400);
        }
      },
    },
  },
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
