import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Palette,
  Users,
  Mail as MailIcon,
  Upload,
  Save,
  Loader2,
  Plus,
  Trash2,
  Server,
  ShieldCheck,
  X,
  Copy,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useCompanyTheme } from "@/hooks/use-company-theme";
import {
  createCompanyUser,
  deleteCompanyUser,
} from "@/lib/company-admin.functions";

interface Company {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  brand_primary: string;
  brand_accent: string;
  app_name: string | null;
}

interface CompanyUser {
  id: string;
  email: string;
  full_name: string | null;
}

interface MailAccount {
  id: string;
  user_id: string;
  email_address: string;
  display_name: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  is_default: boolean;
}

export const Route = createFileRoute("/_authenticated/company")({
  head: () => ({
    meta: [{ title: "لوحة تحكم الشركة — Reemsoft Mail" }],
  }),
  component: CompanyDashboard,
});

function CompanyDashboard() {
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"branding" | "users" | "accounts">("branding");
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  useCompanyTheme(
    company ? { primary: company.brand_primary, accent: company.brand_accent } : null,
  );


  const load = useCallback(async () => {
    setLoading(true);
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) {
      setLoading(false);
      return;
    }

    const { data: roles } = await supabase
      .from("user_roles")
      .select("role, company_id")
      .eq("user_id", userRes.user.id);

    const adminRole = roles?.find((r) => r.role === "company_admin");
    setIsAdmin(!!adminRole);


    const companyId = adminRole?.company_id;
    if (!companyId) {
      setLoading(false);
      return;
    }

    const [{ data: co }, { data: us }, { data: ma }] = await Promise.all([
      supabase.from("companies").select("*").eq("id", companyId).maybeSingle(),
      supabase
        .from("profiles")
        .select("id, email, full_name")
        .eq("company_id", companyId)
        .order("created_at", { ascending: true }),
      supabase
        .from("mail_accounts")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false }),
    ]);

    if (co) setCompany(co as Company);
    if (us) setUsers(us as CompanyUser[]);
    if (ma) setAccounts(ma as MailAccount[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    if (!company) return;
    setSaving(true);
    const { error } = await supabase
      .from("companies")
      .update({
        name: company.name,
        brand_primary: company.brand_primary,
        brand_accent: company.brand_accent,
        app_name: company.app_name,
        logo_url: company.logo_url,
      })
      .eq("id", company.id);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("تم حفظ التغييرات");
  }
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }


  if (!isAdmin || !company) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div>
          <p className="text-muted-foreground">
            هذه الصفحة مخصّصة لمدراء الشركات فقط.
          </p>
          <Link
            to="/mail"
            className="mt-4 inline-flex rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white"
          >
            الذهاب للبريد
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Link to="/mail" className="rounded-lg p-2 hover:bg-muted">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-lg font-bold">لوحة تحكم الشركة</h1>
          </div>
          {tab === "branding" && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              حفظ
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[220px_1fr] md:p-8">
        <nav className="flex gap-2 overflow-x-auto md:flex-col">
          {[
            { id: "branding", label: "العلامة التجارية", icon: Palette },
            { id: "accounts", label: "حسابات البريد", icon: MailIcon, count: accounts.length },
            { id: "users", label: "المستخدمون", icon: Users, count: users.length },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              className={`flex shrink-0 items-center justify-between gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
                tab === t.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <span className="flex items-center gap-2">
                <t.icon className="h-4 w-4" />
                {t.label}
              </span>
              {typeof t.count === "number" && (
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </nav>

        <main className="min-w-0">
          {tab === "branding" && (
            <BrandingTab company={company} setCompany={setCompany} />
          )}
          {tab === "users" && (
            <UsersTab users={users} onChange={load} />
          )}
          {tab === "accounts" && (
            <AccountsTab
              accounts={accounts}
              users={users}
              companyId={company.id}
              onChange={load}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Branding -- */
function BrandingTab({
  company,
  setCompany,
}: {
  company: Company;
  setCompany: (c: Company) => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
      <h2 className="text-xl font-bold">العلامة التجارية</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        سيرى عملاؤك هذه العلامة في واجهة البريد الخاصة بهم.
      </p>

      <div className="mt-6 space-y-5">
        <Field label="اسم الشركة">
          <input
            value={company.name}
            onChange={(e) => setCompany({ ...company, name: e.target.value })}
            className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </Field>
        <Field label="اسم التطبيق المُخصّص">
          <input
            value={company.app_name ?? ""}
            onChange={(e) => setCompany({ ...company, app_name: e.target.value })}
            placeholder="مثال: Aramco Mail"
            className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <ColorInput
            label="اللون الأساسي"
            value={company.brand_primary}
            onChange={(v) => setCompany({ ...company, brand_primary: v })}
          />
          <ColorInput
            label="لون التمييز"
            value={company.brand_accent}
            onChange={(v) => setCompany({ ...company, brand_accent: v })}
          />
        </div>

        <Field label="شعار الشركة">
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted/30">
              {company.logo_url ? (
                <img
                  src={company.logo_url}
                  alt="Logo"
                  className="h-full w-full rounded-2xl object-cover"
                />
              ) : (
                <Upload className="h-6 w-6 text-muted-foreground" />
              )}
            </div>
            <input
              value={company.logo_url ?? ""}
              onChange={(e) => setCompany({ ...company, logo_url: e.target.value })}
              placeholder="https://... رابط الشعار"
              className="flex-1 rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary"
              dir="ltr"
            />
          </div>
        </Field>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Users -- */
function UsersTab({
  users,
  onChange,
}: {
  users: CompanyUser[];
  onChange: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const create = useServerFn(createCompanyUser);
  const del = useServerFn(deleteCompanyUser);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState({ full_name: "", email: "", password: "" });
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await create({ data: form });
      toast.success("تم إنشاء المستخدم");
      setForm({ full_name: "", email: "", password: "" });
      setOpen(false);
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل الإنشاء");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("حذف هذا المستخدم نهائياً؟")) return;
    setBusyId(id);
    try {
      await del({ data: { user_id: id } });
      toast.success("تم الحذف");
      await onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل الحذف");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">المستخدمون</h2>
          <p className="text-sm text-muted-foreground">
            عملاء شركتك الذين يستخدمون البريد عبر بريدهم وكلمة المرور.
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft"
        >
          <Plus className="h-4 w-4" />
          مستخدم جديد
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        {users.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            لا يوجد مستخدمون بعد. أضف أول عميل لك.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-right text-xs font-medium text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5">الاسم</th>
                <th className="px-4 py-2.5">البريد</th>
                <th className="w-16 px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium">{u.full_name ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground" dir="ltr">
                    {u.email}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDelete(u.id)}
                      disabled={busyId === u.id}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      {busyId === u.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <Modal title="إضافة مستخدم جديد" onClose={() => setOpen(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="الاسم الكامل">
              <input
                required
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </Field>
            <Field label="البريد الإلكتروني (لتسجيل الدخول)">
              <input
                required
                type="email"
                dir="ltr"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </Field>
            <Field label="كلمة مرور مؤقتة">
              <div className="flex gap-2">
                <input
                  required
                  minLength={6}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      password: Math.random().toString(36).slice(2, 12),
                    })
                  }
                  className="rounded-lg border border-input px-3 text-xs hover:bg-muted"
                >
                  توليد
                </button>
              </div>
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-4 py-2 text-sm hover:bg-muted"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                إنشاء
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Accounts -- */
const IMAP_PRESETS = [
  { name: "Gmail", imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  { name: "Outlook / Office 365", imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  { name: "Yahoo", imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
  { name: "iCloud", imap: "imap.mail.me.com", smtp: "smtp.mail.me.com" },
  { name: "Zoho", imap: "imap.zoho.com", smtp: "smtp.zoho.com" },
];

function AccountsTab({
  accounts,
  users,
  companyId,
  onChange,
}: {
  accounts: MailAccount[];
  users: CompanyUser[];
  companyId: string;
  onChange: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const emptyForm = {
    user_id: "",
    display_name: "",
    email_address: "",
    password: "",
    imap_host: "",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "",
    smtp_port: 465,
    smtp_secure: true,
  };
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.user_id) return toast.error("اختر مستخدماً");
    setSubmitting(true);
    // Base64 placeholder — the external IMAP backend will re-encrypt on ingestion.
    const cipher =
      typeof window !== "undefined"
        ? btoa(unescape(encodeURIComponent(form.password)))
        : Buffer.from(form.password).toString("base64");
    const { error } = await supabase.from("mail_accounts").insert({
      company_id: companyId,
      user_id: form.user_id,
      display_name: form.display_name || null,
      email_address: form.email_address,
      credentials_ciphertext: cipher,
      imap_host: form.imap_host,
      imap_port: form.imap_port,
      imap_secure: form.imap_secure,
      smtp_host: form.smtp_host,
      smtp_port: form.smtp_port,
      smtp_secure: form.smtp_secure,
    });
    setSubmitting(false);
    if (error) return toast.error(error.message);
    toast.success("تمت إضافة الحساب");
    setForm(emptyForm);
    setOpen(false);
    await onChange();
  }

  async function handleDelete(id: string) {
    if (!confirm("حذف هذا الحساب؟")) return;
    setBusyId(id);
    const { error } = await supabase.from("mail_accounts").delete().eq("id", id);
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success("تم الحذف");
    await onChange();
  }

  const usersById = new Map(users.map((u) => [u.id, u]));

  function applyPreset(p: (typeof IMAP_PRESETS)[number]) {
    setForm({
      ...form,
      imap_host: p.imap,
      imap_port: 993,
      imap_secure: true,
      smtp_host: p.smtp,
      smtp_port: 465,
      smtp_secure: true,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">حسابات البريد (IMAP/SMTP)</h2>
          <p className="text-sm text-muted-foreground">
            أضف إعدادات البريد لكل عميل. سيدخل هو فقط ببريده وكلمة مرور المنصّة.
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          disabled={users.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
          title={users.length === 0 ? "أضف مستخدماً أولاً" : undefined}
        >
          <Plus className="h-4 w-4" />
          حساب جديد
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        {accounts.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            لا توجد حسابات بريد بعد.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map((a) => {
              const u = usersById.get(a.user_id);
              return (
                <li key={a.id} className="flex items-center gap-4 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-gradient/10 text-brand-accent">
                    <Server className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold" dir="ltr">
                        {a.email_address}
                      </p>
                      {a.is_default && (
                        <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600">
                          افتراضي
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {u ? `${u.full_name ?? u.email}` : "مستخدم محذوف"} ·
                      <span dir="ltr" className="mx-1">
                        {a.imap_host}:{a.imap_port}
                      </span>
                      · SMTP
                      <span dir="ltr" className="mx-1">
                        {a.smtp_host}:{a.smtp_port}
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(a.id)}
                    disabled={busyId === a.id}
                    className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  >
                    {busyId === a.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {open && (
        <Modal title="إعدادات بريد جديدة" onClose={() => setOpen(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="المستخدم">
              <select
                required
                value={form.user_id}
                onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              >
                <option value="">— اختر —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name ?? u.email}
                  </option>
                ))}
              </select>
            </Field>

            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                اختصارات:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {IMAP_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:border-primary hover:bg-muted"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="البريد الإلكتروني">
                <input
                  required
                  type="email"
                  dir="ltr"
                  value={form.email_address}
                  onChange={(e) =>
                    setForm({ ...form, email_address: e.target.value })
                  }
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </Field>
              <Field label="اسم العرض (اختياري)">
                <input
                  value={form.display_name}
                  onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </Field>
            </div>

            <Field label="كلمة مرور البريد">
              <input
                required
                type="password"
                dir="ltr"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </Field>

            <fieldset className="rounded-xl border border-border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                خادم الوارد (IMAP)
              </legend>
              <div className="grid gap-3 sm:grid-cols-[1fr_100px_auto]">
                <input
                  required
                  placeholder="imap.example.com"
                  dir="ltr"
                  value={form.imap_host}
                  onChange={(e) => setForm({ ...form, imap_host: e.target.value })}
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <input
                  required
                  type="number"
                  value={form.imap_port}
                  onChange={(e) =>
                    setForm({ ...form, imap_port: Number(e.target.value) })
                  }
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.imap_secure}
                    onChange={(e) =>
                      setForm({ ...form, imap_secure: e.target.checked })
                    }
                  />
                  SSL
                </label>
              </div>
            </fieldset>

            <fieldset className="rounded-xl border border-border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                خادم الصادر (SMTP)
              </legend>
              <div className="grid gap-3 sm:grid-cols-[1fr_100px_auto]">
                <input
                  required
                  placeholder="smtp.example.com"
                  dir="ltr"
                  value={form.smtp_host}
                  onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <input
                  required
                  type="number"
                  value={form.smtp_port}
                  onChange={(e) =>
                    setForm({ ...form, smtp_port: Number(e.target.value) })
                  }
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.smtp_secure}
                    onChange={(e) =>
                      setForm({ ...form, smtp_secure: e.target.checked })
                    }
                  />
                  SSL
                </label>
              </div>
            </fieldset>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-4 py-2 text-sm hover:bg-muted"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                حفظ الإعدادات
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- shared -- */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-2 py-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-transparent px-2 text-sm outline-none"
          dir="ltr"
        />
      </div>
    </Field>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-float"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// silence unused imports (kept for future use)
void Copy;
void Check;
