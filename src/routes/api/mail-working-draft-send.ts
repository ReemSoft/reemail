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
          const expectedRevision = Number(body.expectedRevision);
          const confirmResendUnknown = body.confirmResendUnknown === true;
          if (!token || !draftId) return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
            return json({ ok: false, error: "EXPECTED_REVISION_REQUIRED" }, 400);
          }
          const working = await import("@/lib/mail-working-draft.server");
          const auth = await working.resolveWorkingDraftAuth(token);
          if (working.isAuthError(auth)) return json({ ok: false, error: auth.code }, auth.status);
          const result = await working.sendWorkingDraft({
            auth,
            draftId,
            expectedRevision,
            confirmResendUnknown,
          });
          return json(result);
        } catch (error) {
          const code = error instanceof Error ? error.message : "SEND_FAILED";
          if (code === "WORKING_DRAFT_REVISION_CONFLICT") {
            return json(
              { ok: false, error: "تم تعديل المسودة في نافذة أخرى. راجع أحدث نسخة قبل الإرسال." },
              409,
            );
          }
          if (code === "SEND_OUTCOME_UNKNOWN") {
            return json(
              {
                ok: false,
                code,
                error:
                  "تعذّر التأكد من نتيجة الإرسال. تحقق من مجلد المرسلة قبل اختيار إعادة الإرسال.",
              },
              409,
            );
          }
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
