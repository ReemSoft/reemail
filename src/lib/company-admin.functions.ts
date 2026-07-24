import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Admin creates a new end-user account under their company.
 * Uses service-role client to create the auth user, then attaches profile + role.
 */
export const createCompanyUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { email: string; password: string; full_name: string }) => {
      if (!input.email || !input.email.includes("@")) throw new Error("بريد غير صالح");
      if (!input.password || input.password.length < 6)
        throw new Error("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // 1) Ensure caller is a company_admin and get their company_id
    const { data: adminRoles, error: roleErr } = await supabase
      .from("user_roles")
      .select("company_id, role")
      .eq("user_id", userId)
      .eq("role", "company_admin");
    if (roleErr) throw new Error(roleErr.message);
    const companyId = adminRoles?.[0]?.company_id;
    if (!companyId) throw new Error("ليس لديك صلاحية مدير شركة");

    // 2) Create the auth user with admin API
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.full_name },
    });
    if (createErr) throw new Error(createErr.message);
    const newUserId = created.user?.id;
    if (!newUserId) throw new Error("فشل إنشاء المستخدم");

    // 3) Ensure profile exists and is attached to the company
    await supabaseAdmin.from("profiles").upsert(
      {
        id: newUserId,
        email: data.email,
        full_name: data.full_name,
        company_id: companyId,
      },
      { onConflict: "id" },
    );

    // 4) Assign end_user role scoped to the company
    await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newUserId, role: "end_user", company_id: companyId });

    return { id: newUserId, email: data.email, full_name: data.full_name };
  });

/** Delete a user that belongs to the caller's company. */
export const deleteCompanyUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: adminRoles } = await supabase
      .from("user_roles")
      .select("company_id")
      .eq("user_id", userId)
      .eq("role", "company_admin");
    const companyId = adminRoles?.[0]?.company_id;
    if (!companyId) throw new Error("ليس لديك صلاحية");

    // verify target belongs to same company
    const { data: target } = await supabase
      .from("profiles")
      .select("company_id")
      .eq("id", data.user_id)
      .maybeSingle();
    if (!target || target.company_id !== companyId)
      throw new Error("لا يمكنك حذف مستخدم خارج شركتك");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** One-time bootstrap: claim super_admin if none exists yet. */
export const claimSuperAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("claim_super_admin");
    if (error) throw new Error(error.message);
    return data as { ok: boolean; company_id: string | null };
  });
