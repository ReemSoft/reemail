import { createFileRoute } from "@tanstack/react-router";

const FOLDERS = new Set([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
]);

export const Route = createFileRoute("/api/mail-eml-ticket")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();

          const token =
            typeof body?.mailSessionToken === "string"
              ? body.mailSessionToken
              : "";
          const password =
            typeof body?.password === "string"
              ? body.password
              : "";
          const folder =
            typeof body?.folder === "string"
              ? body.folder
              : "";
          const uid = Number(body?.uid);
          const uidValidity =
            typeof body?.uidValidity === "string"
              ? body.uidValidity
              : "";
          const filename =
            typeof body?.filename === "string"
              ? body.filename
              : "";

          if (!token || !password) {
            return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          }

          if (
            !FOLDERS.has(folder) ||
            !Number.isInteger(uid) ||
            uid <= 0 ||
            !/^[1-9]\d*$/.test(uidValidity) ||
            uidValidity.length > 64 ||
            filename !== `message-${uid}.eml`
          ) {
            return json({ ok: false, error: "INVALID_PAYLOAD" }, 400);
          }

          const { resolveBridgeAuth } =
            await import("@/lib/mail-bridge-auth.server");
          const auth = await resolveBridgeAuth(token);

          if (!auth.ok) {
            return json({ ok: false, error: auth.error }, auth.status);
          }

          const upstream = await fetch(
            `${auth.bridgeUrl}/api/eml-download-ticket`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Bridge-Key": auth.bridgeKey,
              },
              body: JSON.stringify({
                account: auth.bridgeAccount,
                password,
                folder,
                uid,
                expectedUidValidity: uidValidity,
                filename,
              }),
            },
          );

          const result = await upstream.text();

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
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}
