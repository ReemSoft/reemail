// Diagnostic server function used by Phase-1 to prove the encrypted-credentials
// round-trip end-to-end WITHOUT a browser-supplied password:
//
//   1) verify the caller's Mail Session Token (proves account+company identity)
//   2) load the stored ciphertext, decrypt it server-side
//   3) call Bridge /api/verify with the decrypted password
//   4) return a boolean + machine-readable code — never the plaintext
//
// This is the same primitive Phase-2's Worker will use to open IMAP
// without a browser session.
import { createServerFn } from "@tanstack/react-start";

export const credentialRoundTripCheck = createServerFn({ method: "POST" })
  .inputValidator((input: { mailSessionToken: string }) => {
    if (!input || typeof input.mailSessionToken !== "string" || input.mailSessionToken.length < 20) {
      return { mailSessionToken: "", invalid: true as const };
    }
    return { mailSessionToken: input.mailSessionToken };
  })
  .handler(async ({ data }) => {
    if ("invalid" in data) return { ok: false as const, code: "INVALID_INPUT" as const };
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false as const, code: "INVALID_SESSION" as const };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { serverSideVerifyWithStoredCredentials } = await import(
      "@/lib/mail-server-verify.server"
    );
    const result = await serverSideVerifyWithStoredCredentials(
      supabaseAdmin,
      claims.sub,
      claims.cid,
    );

    // Result already excludes plaintext by construction.
    return result;
  });
