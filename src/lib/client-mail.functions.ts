import { createServerFn } from "@tanstack/react-start";

/**
 * Client (email-owner) login.
 * The client is NOT a platform user — they are simply the owner of an email
 * address the company admin has configured. We look up the mail_account by
 * email and (for now, until real IMAP is wired) accept any non-empty password.
 * The password stays only in the browser session, never in the database.
 */
export const clientLogin = createServerFn({ method: "POST" })
  .inputValidator((input: { email: string; password: string }) => {
    if (!input.email || !input.email.includes("@")) throw new Error("بريد غير صالح");
    if (!input.password || input.password.length < 3)
      throw new Error("كلمة المرور مطلوبة");
    return { email: input.email.trim().toLowerCase(), password: input.password };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: account, error } = await supabaseAdmin
      .from("mail_accounts")
      .select(
        "id, company_id, email_address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure",
      )
      .ilike("email_address", data.email)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!account) throw new Error("هذا البريد غير مُسجّل. تواصل مع شركتك.");

    // Load company branding for white-label display.
    const { data: company } = await supabaseAdmin
      .from("companies")
      .select("id, name, app_name, logo_url, brand_primary, brand_accent")
      .eq("id", account.company_id)
      .maybeSingle();

    // TODO(phase-2): verify password against real IMAP server here.
    return { account, company };
  });
