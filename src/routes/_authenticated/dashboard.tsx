import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Palette,
  Mail as MailIcon,
  Upload,
  Save,
  Loader2,
  Plus,
  Trash2,
  Server,
  X,
  Copy,
  Check,
  LogOut,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCompanyTheme } from "@/hooks/use-company-theme";

interface Company {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  brand_primary: string;
  brand_accent: string;
  app_name: string | null;
}

interface MailAccount {
  id: string;
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

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [{ title: "لوحة تحكم الشركة — Reemsoft Mail" }],
  }),
  component: CompanyDashboard,
});

function CompanyDashboard() {
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"branding" | "accounts">("branding");
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const navigate = useNavigate();

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

    const [{ data: co }, { data: ma }] = await Promise.all([
      supabase.from("companies").select("*").eq("id", companyId).maybeSingle(),
      supabase
        .from("mail_accounts")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false }),
    ]);

    if (co) setCompany(co as Company);
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

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
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
        <div className="flex flex-col items-center gap-3">
          <p className="text-muted-foreground">
            هذه الصفحة مخصّصة لمدراء الشركات فقط.
          </p>
          <Link
            to="/mail"
            className="inline-flex rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white"
          >
            الذهاب للبريد
          </Link>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive"
          >
            <LogOut className="h-4 w-4" />
            تسجيل الخروج
          </button>
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
          <div className="flex items-center gap-2">
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
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-destructive hover:text-destructive-foreground"
              title="تسجيل الخروج"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">خروج</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[220px_1fr] md:p-8">
        <nav className="flex gap-2 overflow-x-auto md:flex-col">
          {[
            { id: "branding", label: "العلامة التجارية", icon: Palette },
            { id: "accounts", label: "حسابات البريد", icon: MailIcon, count: accounts.length },
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
          {tab === "accounts" && (
            <AccountsTab
              accounts={accounts}
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

/* Users tab removed — clients are not platform users, only email addresses under a company. */

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
  const [editingId, setEditingId] = useState<string | null>(null);

  const emptyForm = {
    user_id: "",
    display_name: "",
    email_address: "",
    imap_host: "",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "",
    smtp_port: 465,
    smtp_secure: true,
  };
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  function closeModal() {
    setOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  function startEdit(account: MailAccount) {
    setEditingId(account.id);
    setForm({
      user_id: account.user_id,
      display_name: account.display_name || "",
      email_address: account.email_address,
      imap_host: account.imap_host,
      imap_port: account.imap_port,
      imap_secure: account.imap_secure,
      smtp_host: account.smtp_host,
      smtp_port: account.smtp_port,
      smtp_secure: account.smtp_secure,
    });
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.user_id) return toast.error("اختر مستخدماً");
    setSubmitting(true);

    const basePayload = {
      user_id: form.user_id,
      display_name: form.display_name || null,
      email_address: form.email_address,
      imap_host: form.imap_host,
      imap_port: form.imap_port,
      imap_secure: form.imap_secure,
      smtp_host: form.smtp_host,
      smtp_port: form.smtp_port,
      smtp_secure: form.smtp_secure,
    };

    if (editingId) {
      const { error } = await supabase
        .from("mail_accounts")
        .update(basePayload)
        .eq("id", editingId);
      setSubmitting(false);
      if (error) return toast.error(error.message);
      toast.success("تم تحديث الحساب");
    } else {
      const { error } = await supabase.from("mail_accounts").insert({
        company_id: companyId,
        ...basePayload,
        credentials_ciphertext: null,
      });
      setSubmitting(false);
      if (error) return toast.error(error.message);
      toast.success("تمت إضافة الحساب");
    }

    closeModal();
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
            أضف عنوان البريد وإعدادات السيرفر فقط. كلمة مرور البريد يُدخلها العميل بنفسه عند فتح صندوقه.
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
                    onClick={() => startEdit(a)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                    title="تعديل"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(a.id)}
                    disabled={busyId === a.id}
                    className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    title="حذف"
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
        <Modal
          title={editingId ? "تعديل إعدادات البريد" : "إعدادات بريد جديدة"}
          onClose={closeModal}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="المستخدم">
              <select
                required
                disabled={!!editingId}
                value={form.user_id}
                onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
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
