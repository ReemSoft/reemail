import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const TokenSchema = z.string().min(20).max(4096);
const LoadSchema = z.object({ mailSessionToken: TokenSchema }).strict();
const SaveSchema = z
  .object({ mailSessionToken: TokenSchema, html: z.string().max(250_000) })
  .strict();

export type SignatureResult =
  | { ok: true; html: string }
  | { ok: false; code: "INVALID_TOKEN" | "LOAD_FAILED" | "SAVE_FAILED" };

export const loadMailSignature = createServerFn({ method: "POST" })
  .inputValidator((input: z.input<typeof LoadSchema>) => LoadSchema.parse(input))
  .handler(async ({ data }): Promise<SignatureResult> => {
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let accountId: string;
    try {
      accountId = (await verifyMailSessionToken(data.mailSessionToken)).sub;
    } catch {
      return { ok: false, code: "INVALID_TOKEN" };
    }
    const result = await supabaseAdmin
      .from("mail_signatures")
      .select("html")
      .eq("account_id", accountId)
      .maybeSingle();
    if (result.error) return { ok: false, code: "LOAD_FAILED" };
    return { ok: true, html: result.data?.html ?? "" };
  });

export const saveMailSignature = createServerFn({ method: "POST" })
  .inputValidator((input: z.input<typeof SaveSchema>) => SaveSchema.parse(input))
  .handler(async ({ data }): Promise<SignatureResult> => {
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let accountId: string;
    try {
      accountId = (await verifyMailSessionToken(data.mailSessionToken)).sub;
    } catch {
      return { ok: false, code: "INVALID_TOKEN" };
    }
    const result = await supabaseAdmin
      .from("mail_signatures")
      .upsert({ account_id: accountId, html: data.html }, { onConflict: "account_id" });
    if (result.error) return { ok: false, code: "SAVE_FAILED" };
    return { ok: true, html: data.html };
  });