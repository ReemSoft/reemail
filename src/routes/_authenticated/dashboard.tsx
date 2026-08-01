import { ArrowBackward } from "@/components/ui/directional-icon";
import { tr } from "@/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
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
  Globe,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCompanyTheme } from "@/hooks/use-company-theme";
import { useConfirm } from "@/components/ui/confirm-provider";

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
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: boolean | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  source_domain_id: string | null;
  is_default: boolean;
}

interface EmailDomain {
  id: string;
  domain: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
}

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [{ title: "لوحة تحكم الشركة — MailMaestro" }],
  }),
  component: CompanyDashboard,
});

function CompanyDashboard() {
  const [company, setCompany] = useState<Company | null>(null);
  const [originalCompany, setOriginalCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"branding" | "accounts" | "domains">("branding");
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [domains, setDomains] = useState<EmailDomain[]>([]);
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

    const [{ data: co }, { data: ma }, { data: dm }] = await Promise.all([
      supabase.from("companies").select("*").eq("id", companyId).maybeSingle(),
      supabase
        .from("mail_accounts")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false }),
      supabase
        .from("email_domains")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false }),
    ]);

    if (co) {
      setCompany(co as Company);
      setOriginalCompany(co as Company);
    }
    if (ma) setAccounts(ma as MailAccount[]);
    if (dm) setDomains(dm as EmailDomain[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasChanges =
    !!company &&
    !!originalCompany &&
    (company.name !== originalCompany.name ||
      company.brand_primary !== originalCompany.brand_primary ||
      company.brand_accent !== originalCompany.brand_accent ||
      company.app_name !== originalCompany.app_name ||
      company.logo_url !== originalCompany.logo_url);

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
    setOriginalCompany(company);
    toast.success(tr("تم حفظ التغييرات"));
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
            {tr("هذه الصفحة مخصّصة لمدراء الشركات فقط.")}
          </p>
          <Link
            to="/mail"
            className="inline-flex rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white"
          >
            {tr("الذهاب للبريد")}
          </Link>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive"
          >
            <LogOut className="h-4 w-4" />
            {tr("تسجيل الخروج")}
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
              <ArrowBackward className="h-4 w-4" />
            </Link>
            <h1 className="text-lg font-bold">{tr("لوحة تحكم الشركة")}</h1>
          </div>
          <div className="flex items-center gap-2">
            {tab === "branding" && (
              <div
                className={`overflow-hidden transition-all duration-200 ease-out ${
                  hasChanges ? "max-w-[120px] opacity-100" : "max-w-0 opacity-0"
                }`}
              >
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
                  {tr("حفظ")}
                </button>
              </div>
            )}
            <LanguageSwitcher />
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-destructive hover:text-destructive-foreground"
              title={tr("تسجيل الخروج")}
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">{tr("خروج")}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[220px_1fr] md:p-8">
        <nav className="flex gap-2 overflow-x-auto md:flex-col">
          {[
            { id: "branding", label: tr("العلامة التجارية"), icon: Palette },
            { id: "accounts", label: tr("حسابات البريد"), icon: MailIcon, count: accounts.length },
            { id: "domains", label: tr("دومينات مشتركة"), icon: Globe, count: domains.length },
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
          {tab === "domains" && (
            <DomainsTab
              domains={domains}
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
      <h2 className="text-xl font-bold">{tr("العلامة التجارية")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {tr("سيرى عملاؤك هذه العلامة في واجهة البريد الخاصة بهم.")}
      </p>

      <div className="mt-6 space-y-5">
        <Field label={tr("اسم الشركة")}>
          <input
            value={company.name}
            onChange={(e) => setCompany({ ...company, name: e.target.value })}
            className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </Field>
        <Field label={tr("اسم التطبيق المُخصّص")}>
          <input
            value={company.app_name ?? ""}
            onChange={(e) => setCompany({ ...company, app_name: e.target.value })}
            placeholder={tr("مثال: Aramco Mail")}
            className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <ColorInput
            label={tr("اللون الأساسي")}
            value={company.brand_primary}
            onChange={(v) => setCompany({ ...company, brand_primary: v })}
          />
          <ColorInput
            label={tr("لون التمييز")}
            value={company.brand_accent}
            onChange={(v) => setCompany({ ...company, brand_accent: v })}
          />
        </div>

        <Field label={tr("شعار الشركة")}>
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
              placeholder={tr("https://... رابط الشعار")}
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
  domains,
  companyId,
  onChange,
}: {
  accounts: MailAccount[];
  domains: EmailDomain[];
  companyId: string;
  onChange: () => Promise<void> | void;
}) {
  const { confirm } = useConfirm();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const emptyForm = {
    display_name: "",
    email_address: "",
    source_domain_id: "",
    imap_host: "",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "",
    smtp_port: 465,
    smtp_secure: true,
  };
  const [form, setForm] = useState(emptyForm);
  const [useCustom, setUseCustom] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function closeModal() {
    setOpen(false);
    setEditingId(null);
    setForm(emptyForm);
    setUseCustom(false);
  }

  /** Auto-selects the matching domain template while typing the address. */
  function onEmailChange(value: string) {
    const domainPart = value.split("@")[1]?.trim().toLowerCase() ?? "";
    if (useCustom || form.source_domain_id) {
      setForm({ ...form, email_address: value });
      return;
    }
    const match = domains.find((d) => d.domain.toLowerCase() === domainPart);
    setForm({ ...form, email_address: value, source_domain_id: match?.id ?? "" });
  }

  function startEdit(account: MailAccount) {
    const custom = !!account.imap_host;
    setEditingId(account.id);
    setUseCustom(custom);
    setForm({
      display_name: account.display_name || "",
      email_address: account.email_address,
      source_domain_id: account.source_domain_id || "",
      imap_host: account.imap_host || "",
      imap_port: account.imap_port ?? 993,
      imap_secure: account.imap_secure ?? true,
      smtp_host: account.smtp_host || "",
      smtp_port: account.smtp_port ?? 465,
      smtp_secure: account.smtp_secure ?? true,
    });
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!useCustom && !form.source_domain_id) {
      return toast.error(tr("اختر قالب دومين أو فعّل الإعدادات المخصّصة."));
    }

    setSubmitting(true);

    // Domain template mode → leave server fields NULL so the account always
    // inherits the current domain settings (single source of truth).
    const basePayload = useCustom
      ? {
          display_name: form.display_name || null,
          email_address: form.email_address,
          source_domain_id: null,
          imap_host: form.imap_host,
          imap_port: form.imap_port,
          imap_secure: form.imap_secure,
          smtp_host: form.smtp_host,
          smtp_port: form.smtp_port,
          smtp_secure: form.smtp_secure,
        }
      : {
          display_name: form.display_name || null,
          email_address: form.email_address,
          source_domain_id: form.source_domain_id,
          imap_host: null,
          imap_port: null,
          imap_secure: null,
          smtp_host: null,
          smtp_port: null,
          smtp_secure: null,
        };

    if (editingId) {
      const { error } = await supabase
        .from("mail_accounts")
        .update(basePayload)
        .eq("id", editingId);
      setSubmitting(false);
      if (error) return toast.error(error.message);
      toast.success(tr("تم تحديث الحساب"));
    } else {
      const { error } = await supabase.from("mail_accounts").insert({
        company_id: companyId,
        ...basePayload,
        credentials_ciphertext: null,
      });
      setSubmitting(false);
      if (error) return toast.error(error.message);
      toast.success(tr("تمت إضافة الحساب"));
    }

    closeModal();
    await onChange();
  }

  async function handleDelete(id: string) {
    const confirmed = await confirm({
      title: "حذف الحساب",
      description: tr("هل أنت متأكد من حذف هذا الحساب؟ لا يمكن التراجع عن هذا الإجراء."),
      confirmLabel: tr("حذف"),
      cancelLabel: tr("إلغاء"),
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusyId(id);
    const { error } = await supabase.from("mail_accounts").delete().eq("id", id);
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success(tr("تم الحذف"));
    await onChange();
  }

  

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
          <h2 className="text-xl font-bold">{tr("حسابات البريد (IMAP/SMTP)")}</h2>
          <p className="text-sm text-muted-foreground">
            {tr("أضف عنوان البريد وإعدادات السيرفر فقط. كلمة مرور البريد يُدخلها العميل بنفسه عند فتح صندوقه.")}
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft"
        >
          <Plus className="h-4 w-4" />
          {tr("حساب جديد")}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        {accounts.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {tr("لا توجد حسابات بريد بعد.")}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map((a) => {
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
                          {tr("افتراضي")}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {a.imap_host ? (
                        <>
                          <span dir="ltr" className="mx-1">
                            IMAP {a.imap_host}:{a.imap_port}
                          </span>
                          ·
                          <span dir="ltr" className="mx-1">
                            SMTP {a.smtp_host}:{a.smtp_port}
                          </span>
                        </>
                      ) : (
                        <span>
                          {tr("يرث إعدادات قالب الدومين")}
                          {a.source_domain_id
                            ? ` @${domains.find((d) => d.id === a.source_domain_id)?.domain ?? ""}`
                            : ""}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => startEdit(a)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                    title={tr("تعديل")}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(a.id)}
                    disabled={busyId === a.id}
                    className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    title={tr("حذف")}
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
          title={editingId ? tr("تعديل إعدادات البريد") : tr("إعدادات بريد جديدة")}
          onClose={closeModal}
        >
          <form onSubmit={handleSubmit} className="space-y-4">

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tr("البريد الإلكتروني")}>
                <input
                  required
                  type="email"
                  dir="ltr"
                  value={form.email_address}
                  onChange={(e) => onEmailChange(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </Field>
              <Field label={tr("اسم العرض (اختياري)")}>
                <input
                  value={form.display_name}
                  onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </Field>
            </div>

            <Field label={tr("إعدادات السيرفر")}>
              <select
                value={useCustom ? "custom" : form.source_domain_id}
                onChange={(e) => {
                  if (e.target.value === "custom") {
                    setUseCustom(true);
                    setForm({ ...form, source_domain_id: "" });
                  } else {
                    setUseCustom(false);
                    setForm({ ...form, source_domain_id: e.target.value });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              >
                <option value="">{tr("— اختر قالب دومين —")}</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    @{d.domain}
                  </option>
                ))}
                <option value="custom">{tr("إعدادات مخصّصة لهذا البريد")}</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {useCustom
                  ? tr("سيتم استخدام الإعدادات المُدخلة أدناه لهذا البريد فقط.")
                  : tr("سيرث هذا البريد إعدادات IMAP/SMTP من قالب الدومين تلقائياً.")}
              </p>
            </Field>

            {useCustom && (
              <>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {tr("اختصارات:")}
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

                <fieldset className="rounded-xl border border-border p-3">
                  <legend className="px-1 text-xs font-semibold text-muted-foreground">
                    {tr("خادم الوارد (IMAP)")}
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
                      onChange={(e) => setForm({ ...form, imap_port: Number(e.target.value) })}
                      className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={form.imap_secure}
                        onChange={(e) => setForm({ ...form, imap_secure: e.target.checked })}
                      />
                      SSL
                    </label>
                  </div>
                </fieldset>

                <fieldset className="rounded-xl border border-border p-3">
                  <legend className="px-1 text-xs font-semibold text-muted-foreground">
                    {tr("خادم الصادر (SMTP)")}
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
                      onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })}
                      className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={form.smtp_secure}
                        onChange={(e) => setForm({ ...form, smtp_secure: e.target.checked })}
                      />
                      SSL
                    </label>
                  </div>
                </fieldset>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-4 py-2 text-sm hover:bg-muted"
              >
                {tr("إلغاء")}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {tr("حفظ الإعدادات")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
/* --------------------------------------------------------------- Domains -- */
function DomainsTab({
  domains,
  companyId,
  onChange,
}: {
  domains: EmailDomain[];
  companyId: string;
  onChange: () => Promise<void> | void;
}) {
  const { confirm } = useConfirm();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const emptyForm = {
    domain: "",
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

  function startEdit(d: EmailDomain) {
    setEditingId(d.id);
    setForm({
      domain: d.domain,
      imap_host: d.imap_host,
      imap_port: d.imap_port,
      imap_secure: d.imap_secure,
      smtp_host: d.smtp_host,
      smtp_port: d.smtp_port,
      smtp_secure: d.smtp_secure,
    });
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const payload = {
      domain: form.domain.trim().toLowerCase().replace(/^@/, ""),
      imap_host: form.imap_host.trim(),
      imap_port: form.imap_port,
      imap_secure: form.imap_secure,
      smtp_host: form.smtp_host.trim(),
      smtp_port: form.smtp_port,
      smtp_secure: form.smtp_secure,
    };
    if (!payload.domain.includes(".")) {
      setSubmitting(false);
      return toast.error(tr("أدخل دومين صحيح مثل example.com"));
    }
    if (editingId) {
      const { error } = await supabase
        .from("email_domains")
        .update(payload)
        .eq("id", editingId);
      setSubmitting(false);
      if (error) return toast.error(error.message);
      toast.success(tr("تم تحديث الدومين"));
    } else {
      const { error } = await supabase
        .from("email_domains")
        .insert({ company_id: companyId, ...payload });
      setSubmitting(false);
      if (error) return toast.error(error.message);
      toast.success(tr("تمت إضافة الدومين"));
    }
    closeModal();
    await onChange();
  }

  async function handleDelete(id: string) {
    const confirmed = await confirm({
      title: "حذف إعدادات الدومين",
      description: tr("هل أنت متأكد من حذف إعدادات هذا الدومين؟ لا يمكن التراجع عن هذا الإجراء."),
      confirmLabel: tr("حذف"),
      cancelLabel: tr("إلغاء"),
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusyId(id);
    const { error } = await supabase.from("email_domains").delete().eq("id", id);
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success(tr("تم الحذف"));
    await onChange();
  }

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
          <h2 className="text-xl font-bold">{tr("قوالب الدومين")}</h2>
          <p className="text-sm text-muted-foreground">
            {tr("أضف إعدادات IMAP/SMTP للدومين مرة واحدة، ثم اربط بها إيميلاتك بدون إعادة إدخالها. إضافة الدومين وحدها لا تسمح بدخول أي بريد غير مُضاف.")}
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft"
        >
          <Plus className="h-4 w-4" />
          {tr("دومين جديد")}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        {domains.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {tr("لم تُضف أي دومين بعد.")}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {domains.map((d) => (
              <li key={d.id} className="flex items-center gap-4 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-gradient/10 text-brand-accent">
                  <Globe className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold" dir="ltr">
                    @{d.domain}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="ltr">
                    IMAP {d.imap_host}:{d.imap_port} · SMTP {d.smtp_host}:{d.smtp_port}
                  </p>
                </div>
                <button
                  onClick={() => startEdit(d)}
                  className="rounded-md p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                  title={tr("تعديل")}
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleDelete(d.id)}
                  disabled={busyId === d.id}
                  className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  title={tr("حذف")}
                >
                  {busyId === d.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <Modal
          title={editingId ? tr("تعديل إعدادات الدومين") : tr("إعدادات دومين جديدة")}
          onClose={closeModal}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{tr("اختصارات:")}</p>
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

            <Field label={tr("الدومين")}>
              <input
                required
                dir="ltr"
                placeholder="example.com"
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </Field>

            <fieldset className="rounded-xl border border-border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                {tr("خادم الوارد (IMAP)")}
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
                  onChange={(e) => setForm({ ...form, imap_port: Number(e.target.value) })}
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.imap_secure}
                    onChange={(e) => setForm({ ...form, imap_secure: e.target.checked })}
                  />
                  SSL
                </label>
              </div>
            </fieldset>

            <fieldset className="rounded-xl border border-border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                {tr("خادم الصادر (SMTP)")}
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
                  onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })}
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.smtp_secure}
                    onChange={(e) => setForm({ ...form, smtp_secure: e.target.checked })}
                  />
                  SSL
                </label>
              </div>
            </fieldset>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeModal}
                className="rounded-lg px-4 py-2 text-sm hover:bg-muted"
              >
                {tr("إلغاء")}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {tr("حفظ")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}


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
