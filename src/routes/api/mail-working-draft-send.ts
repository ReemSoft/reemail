import { createFileRoute } from "@tanstack/react-router";

/** Draft-origin send path; normal /api/mail-send-v2 remains untouched. */
export const Route = createFileRoute("/api/mail-working-draft-send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const token = typeof body.mailSessionToken === "string" ? body.mailSessionToken : "";
          const draftId = typeof body.draftId === "string" ? body.draftId : "";
          if (!token || !draftId) return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          const working = await import("@/lib/mail-working-draft.server");
          const auth = await working.resolveWorkingDraftAuth(token);
          if (working.isAuthError(auth)) return json({ ok: false, error: auth.code }, auth.status);
          const result = await working.sendWorkingDraft({ auth, draftId });
          return json(result);
        } catch (error) {
          const code = error instanceof Error ? error.message : "SEND_FAILED";
          return json({ ok: false, error: code }, 500);
        }
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
