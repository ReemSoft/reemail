import { createServerFn } from "@tanstack/react-start";

/**
 * Client (email-owner) login.
 *
 * Domain-first flow:
 * 1. Extract the domain from the entered email.
 * 2. Look up `email_domains` to get server settings + company.
 * 3. Optionally read an existing `mail_accounts` row for per-user overrides
 *    (display_name, or custom host/port if this specific address uses a
 *    different mailbox). If none exists, auto-create one for future edits.
 * 4. Merge (account override ?? domain default) and verify against the bridge.
 * The password stays only in the browser session, never in the database.
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

    const domainPart = data.email.split("@")[1]?.toLowerCase();
    if (!domainPart) {
      return { ok: false as const, message: "بريد غير صالح" };
    }

    // 1) Domain settings (source of truth)
    const { data: domain, error: domainErr } = await supabaseAdmin
      .from("email_domains")
      .select(
        "id, company_id, domain, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure",
      )
      .ilike("domain", domainPart)
      .maybeSingle();

    if (domainErr) {
      return { ok: false as const, message: "تعذر التحقق من إعدادات الدومين الآن." };
    }
    if (!domain) {
      return {
        ok: false as const,
        message: "دومين هذا البريد غير مُسجَّل. تواصل مع مسؤول شركتك.",
      };
    }

    // 2) Optional per-address overrides (display_name, custom host, etc.)
    const { data: existingAccount } = await supabaseAdmin
      .from("mail_accounts")
      .select(
        "id, company_id, email_address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure",
      )
      .ilike("email_address", data.email)
      .maybeSingle();

    let accountRow = existingAccount;

    // Auto-create a lightweight account row on first login so future overrides
    // (display name, custom port…) have a stable id to edit.
    if (!accountRow) {
      const { data: inserted } = await supabaseAdmin
        .from("mail_accounts")
        .insert({
          company_id: domain.company_id,
          email_address: data.email,
          display_name: null,
          credentials_ciphertext: null,
        })
        .select(
          "id, company_id, email_address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure",
        )
        .maybeSingle();
      accountRow = inserted ?? null;
    }

    // 3) Merge: override wins when set; otherwise domain default.
    const account = {
      id: accountRow?.id ?? domain.id,
      company_id: domain.company_id,
      email_address: data.email,
      display_name: accountRow?.display_name ?? null,
      imap_host: accountRow?.imap_host ?? domain.imap_host,
      imap_port: accountRow?.imap_port ?? domain.imap_port,
      imap_secure: accountRow?.imap_secure ?? domain.imap_secure,
      smtp_host: accountRow?.smtp_host ?? domain.smtp_host,
      smtp_port: accountRow?.smtp_port ?? domain.smtp_port,
      smtp_secure: accountRow?.smtp_secure ?? domain.smtp_secure,
    };

    const { data: company } = await supabaseAdmin
      .from("companies")
      .select("id, name, app_name, logo_url, brand_primary, brand_accent")
      .eq("id", domain.company_id)
      .maybeSingle();

    // 4) Verify credentials against the real IMAP server.
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

    return { ok: true as const, account, company };
  });
