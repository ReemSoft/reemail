import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail-working-draft-checkpoint")({
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
          const result = await working.checkpointWorkingDraft({ auth, draftId });
          return json(result, result.ok ? 200 : 503);
        } catch (error) {
          const code = error instanceof Error ? error.message : "CHECKPOINT_FAILED";
          return json({ ok: false, code }, 503);
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
