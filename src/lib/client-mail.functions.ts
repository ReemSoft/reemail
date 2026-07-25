import { createServerFn } from "@tanstack/react-start";

/**
 * Client (email-owner) login.
 * The client is NOT a platform user — they are simply the owner of an email
 * address the company admin has configured. We look up the mail_account by
 * email, then verify the password directly against the real IMAP server via
 * the bridge. The password stays only in the browser session, never in the database.
 */
export const clientLogin = createServerFn({ method: "POST" })
  .inputValidator((input: { email: string; password: string }) => {
    if (!input.email || !input.email.includes("@")) {
      return { email: "", password: input.password ?? "", validationError: "بريد غير صالح" };
    }
    if (!input.password || input.password.length < 3) {
      return {
        email: input.email.trim().toLowerCase(),
        password: input.password ?? "",
        validationError: "كلمة المرور مطلوبة",
      };
    }
    return { email: input.email.trim().toLowerCase(), password: input.password };
  })
  .handler(async ({ data }) => {
    if ("validationError" in data) {
      return { ok: false as const, message: data.validationError };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: account, error } = await supabaseAdmin
      .from("mail_accounts")
      .select(
        "id, company_id, email_address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure",
      )
      .ilike("email_address", data.email)
      .maybeSingle();

    if (error) {
      return { ok: false as const, message: "تعذر التحقق من البريد الآن. حاول مرة أخرى." };
    }
    if (!account) {
      return { ok: false as const, message: "هذا البريد غير مُسجّل. تواصل مع شركتك." };
    }
    if (
      !account.imap_host ||
      !account.imap_port ||
      account.imap_secure == null ||
      !account.smtp_host ||
      !account.smtp_port ||
      account.smtp_secure == null
    ) {
      return {
        ok: false as const,
        message: "إعدادات البريد لهذا الحساب غير مكتملة. تواصل مع المشرف.",
      };
    }

    const configuredAccount = {
      ...account,
      imap_host: account.imap_host,
      imap_port: account.imap_port,
      imap_secure: account.imap_secure,
      smtp_host: account.smtp_host,
      smtp_port: account.smtp_port,
      smtp_secure: account.smtp_secure,
    };

    const { data: company } = await supabaseAdmin
      .from("companies")
      .select("id, name, app_name, logo_url, brand_primary, brand_accent")
      .eq("id", account.company_id)
      .maybeSingle();

    // Verify credentials against the real IMAP server.
    const bridgeUrl = process.env.MAIL_BRIDGE_URL;
    const bridgeKey = process.env.MAIL_BRIDGE_SECRET;

    if (!bridgeUrl || !bridgeKey) {
      return {
        ok: false as const,
        message: "خادم البريد لم يُربط بعد. أخبر فريق الدعم برابط الـ Bridge.",
      };
    }

    try {
      const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/api/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Key": bridgeKey,
        },
        body: JSON.stringify({ account, password: data.password }),
      });
      const rawText = await res.text();
      let json: any = {};
      try { json = JSON.parse(rawText); } catch { /* not json */ }
      if (!res.ok || !json.ok) {
        console.error("[clientLogin] bridge verify failed", {
          status: res.status,
          bridgeUrl,
          bridgeKeyPrefix: bridgeKey.slice(0, 6),
          body: rawText.slice(0, 300),
        });
        return {
          ok: false as const,
          message: `فشل التحقق (${res.status}): ${json.error || rawText.slice(0, 120) || "خطأ غير معروف"}`,
        };
      }
    } catch (err) {
      console.error("[clientLogin] bridge fetch threw", err);
      return {
        ok: false as const,
        message: `تعذر الاتصال بخادم البريد: ${err instanceof Error ? err.message : String(err)}`,
      };
    }


    return { ok: true as const, account: configuredAccount, company };
  });
