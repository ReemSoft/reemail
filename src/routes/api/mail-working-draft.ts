import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail-working-draft")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const token = typeof body.mailSessionToken === "string" ? body.mailSessionToken : "";
          const action = typeof body.action === "string" ? body.action : "";
          const draftId = typeof body.draftId === "string" ? body.draftId : "";
          if (!token || (action !== "list" && !draftId)) {
            return json({ ok: false, code: "SESSION_REQUIRED" }, 401);
          }
          const working = await import("@/lib/mail-working-draft.server");
          const auth = await working.resolveWorkingDraftAuth(token);
          if (working.isAuthError(auth)) return json({ ok: false, code: auth.code }, auth.status);

          if (action === "list") {
            const records = await working.listWorkingDrafts(auth);
            return json({ ok: true, records });
          }
          if (action === "load") {
            const record = await working.loadWorkingDraft(auth, draftId);
            return json({ ok: true, record });
          }
          if (action === "save") {
            const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : -1;
            const result = await working.saveWorkingDraft({
              auth,
              draftId,
              expectedRevision,
              payload: body.payload as never,
            });
            return json(result, result.ok ? 200 : 409);
          }
          if (action === "delete") {
            const result = await working.deleteWorkingDraft({ auth, draftId });
            void working.deleteProviderDraftCheckpoint({
              auth,
              draftId,
              previousRef: result.serverRef,
            });
            return json({ ok: true, deleted: result.deleted });
          }
          return json({ ok: false, code: "INVALID_ACTION" }, 400);
        } catch (error) {
          const code = error instanceof Error ? error.message : "INVALID_PAYLOAD";
          return json({ ok: false, code }, 400);
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
