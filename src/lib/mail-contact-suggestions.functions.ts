// Server functions for the address-book (contact suggestions) feature.
//
// Trust model:
//   * The browser NEVER supplies company_id or mailbox_account_id.
//   * Scope is derived exclusively from a verified `mailSessionToken` (JWT).
//   * All DB access uses supabaseAdmin behind these functions; the table
//     itself is deny_all for anon/authenticated.
//   * The atomic frequency bump lives in `private.record_mail_contact_suggestions`
//     (SECURITY DEFINER, EXECUTE granted only to service_role).
import { createServerFn } from "@tanstack/react-start";
import { verifyMailSessionToken } from "@/lib/mail-token.server";

export interface ContactSuggestion {
  email: string;
  name: string | null;
  frequency: number;
  lastUsedAt: number; // unix ms
}

interface HydrateInput {
  mailSessionToken: string;
}
interface HydrateResult {
  ok: boolean;
  suggestions: ContactSuggestion[];
  scope?: { companyId: string; accountId: string };
  error?: string;
}

interface RecordInput {
  mailSessionToken: string;
  recipients: Array<{ email?: string; name?: string | null }>;
}
interface RecordResult {
  ok: boolean;
  written: number;
  error?: string;
}

interface HideInput {
  mailSessionToken: string;
  email: string;
}
interface HideResult {
  ok: boolean;
  error?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_INPUT_RECIPIENTS = 100;
const MAX_NAME_LEN = 200;
const HYDRATE_LIMIT = 500;

async function assertAccountLive(
  supabaseAdmin: any,
  accountId: string,
  companyId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("mail_accounts")
    .select("id, company_id")
    .eq("id", accountId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) return { ok: false, error: "تعذر التحقق من الحساب." };
  if (!data) return { ok: false, error: "الحساب غير موجود." };
  return { ok: true };
}

export const hydrateContactSuggestions = createServerFn({ method: "POST" })
  .inputValidator((input: HydrateInput) => {
    if (!input || typeof input.mailSessionToken !== "string" || !input.mailSessionToken) {
      throw new Error("mailSessionToken required");
    }
    return { mailSessionToken: input.mailSessionToken };
  })
  .handler(async ({ data }): Promise<HydrateResult> => {
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, suggestions: [], error: "جلسة البريد غير صالحة." };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const live = await assertAccountLive(supabaseAdmin, claims.sub, claims.cid);
    if (!live.ok) return { ok: false, suggestions: [], error: live.error };

    const { data: rows, error } = await supabaseAdmin
      .from("mail_contact_suggestions")
      .select("email_normalized, display_name, frequency, last_used_at")
      .eq("company_id", claims.cid)
      .eq("mailbox_account_id", claims.sub)
      .is("hidden_at", null)
      .order("last_used_at", { ascending: false })
      .limit(HYDRATE_LIMIT);
    if (error) return { ok: false, suggestions: [], error: "تعذر تحميل الاقتراحات." };

    const suggestions: ContactSuggestion[] = (rows ?? []).map((r: any) => ({
      email: r.email_normalized,
      name: r.display_name ?? null,
      frequency: r.frequency ?? 1,
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).getTime() : Date.now(),
    }));
    return {
      ok: true,
      suggestions,
      scope: { companyId: claims.cid, accountId: claims.sub },
    };
  });

export const recordSentRecipients = createServerFn({ method: "POST" })
  .inputValidator((input: RecordInput) => {
    if (!input || typeof input.mailSessionToken !== "string" || !input.mailSessionToken) {
      throw new Error("mailSessionToken required");
    }
    if (!Array.isArray(input.recipients)) throw new Error("recipients must be an array");
    if (input.recipients.length > MAX_INPUT_RECIPIENTS) {
      throw new Error("too many recipients");
    }
    return {
      mailSessionToken: input.mailSessionToken,
      recipients: input.recipients.slice(0, MAX_INPUT_RECIPIENTS),
    };
  })
  .handler(async ({ data }): Promise<RecordResult> => {
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, written: 0, error: "جلسة البريد غير صالحة." };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const live = await assertAccountLive(supabaseAdmin, claims.sub, claims.cid);
    if (!live.ok) return { ok: false, written: 0, error: live.error };

    const ownEmail = (claims.em ?? "").toLowerCase().trim();
    const items: Array<{ email: string; name: string | null }> = [];
    const seen = new Set<string>();
    for (const r of data.recipients) {
      const email = typeof r?.email === "string" ? r.email.trim().toLowerCase() : "";
      if (!email || !EMAIL_RE.test(email)) continue;
      if (email === ownEmail) continue; // never record the sender's own address
      if (seen.has(email)) continue;
      seen.add(email);
      const rawName = typeof r?.name === "string" ? r.name.trim() : "";
      const name = rawName ? rawName.slice(0, MAX_NAME_LEN) : null;
      items.push({ email, name });
    }
    if (items.length === 0) return { ok: true, written: 0 };

    const { data: written, error } = await supabaseAdmin.rpc(
      "record_mail_contact_suggestions" as any,
      {
        p_company_id: claims.cid,
        p_account_id: claims.sub,
        p_items: items,
      } as any,
    );
    if (error) {
      return { ok: false, written: 0, error: error.message };
    }
    return { ok: true, written: typeof written === "number" ? written : items.length };
  });

export const hideContactSuggestion = createServerFn({ method: "POST" })
  .inputValidator((input: HideInput) => {
    if (!input || typeof input.mailSessionToken !== "string" || !input.mailSessionToken) {
      throw new Error("mailSessionToken required");
    }
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!email || !EMAIL_RE.test(email)) throw new Error("invalid email");
    return { mailSessionToken: input.mailSessionToken, email };
  })
  .handler(async ({ data }): Promise<HideResult> => {
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة." };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const live = await assertAccountLive(supabaseAdmin, claims.sub, claims.cid);
    if (!live.ok) return { ok: false, error: live.error };

    const { error } = await supabaseAdmin
      .from("mail_contact_suggestions")
      .update({ hidden_at: new Date().toISOString() })
      .eq("company_id", claims.cid)
      .eq("mailbox_account_id", claims.sub)
      .eq("email_normalized", data.email);
    if (error) return { ok: false, error: "تعذر إخفاء الاقتراح." };
    return { ok: true };
  });
