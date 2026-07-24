import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Palette,
  Users,
  Mail as MailIcon,
  Upload,
  Save,
  Loader2,
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

  // Preview brand while editing
  useCompanyTheme(
    company ? { primary: company.brand_primary, accent: company.brand_accent } : null,
  );

  useEffect(() => {
    (async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("company_id")
        .eq("id", user.user.id)
        .maybeSingle();
      if (!profile?.company_id) {
        // First-time: allow user to view a demo company they don't yet belong to.
        const { data: demo } = await supabase
          .from("companies")
          .select("*")
          .eq("slug", "reemsoft")
          .maybeSingle();
        if (demo) setCompany(demo as Company);
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("companies")
        .select("*")
        .eq("id", profile.company_id)
        .maybeSingle();
      if (data) setCompany(data as Company);
      setLoading(false);
    })();
  }, []);

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

  if (!company) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div>
          <p className="text-muted-foreground">لم يتم ربط حسابك بأي شركة بعد.</p>
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
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            حفظ
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[220px_1fr] md:p-8">
        <nav className="flex gap-2 overflow-x-auto md:flex-col">
          {[
            { id: "branding", label: "العلامة التجارية", icon: Palette },
            { id: "accounts", label: "حسابات البريد", icon: MailIcon },
            { id: "users", label: "المستخدمون", icon: Users },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
                tab === t.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </nav>

        <main className="min-w-0">
          {tab === "branding" && (
            <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
              <h2 className="text-xl font-bold">العلامة التجارية</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                سيرى عملاؤك هذه العلامة في واجهة البريد الخاصة بهم.
              </p>

              <div className="mt-6 space-y-5">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">اسم الشركة</label>
                  <input
                    value={company.name}
                    onChange={(e) => setCompany({ ...company, name: e.target.value })}
                    className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">
                    اسم التطبيق المُخصّص
                  </label>
                  <input
                    value={company.app_name ?? ""}
                    onChange={(e) => setCompany({ ...company, app_name: e.target.value })}
                    placeholder="مثال: Aramco Mail"
                    className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">النطاق الفرعي</label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 rounded-lg border border-input bg-muted/30 px-4 py-2.5 text-sm text-muted-foreground" dir="ltr">
                      {company.slug}.reemsoft-mail.com
                    </div>
                  </div>
                </div>

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

                <div>
                  <label className="mb-1.5 block text-sm font-medium">شعار الشركة</label>
                  <div className="flex items-center gap-4">
                    <div className="flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted/30">
                      {company.logo_url ? (
                        <img src={company.logo_url} alt="Logo" className="h-full w-full rounded-2xl object-cover" />
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
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    مؤقتاً: أدخل رابط مباشر. رفع الملفات سيُضاف قريباً.
                  </p>
                </div>

                {/* Preview */}
                <div>
                  <p className="mb-2 text-sm font-medium">معاينة مباشرة</p>
                  <div className="rounded-xl border border-border bg-brand-gradient p-6 text-white shadow-brand">
                    <div className="flex items-center gap-3">
                      {company.logo_url ? (
                        <img src={company.logo_url} alt="" className="h-10 w-10 rounded-lg bg-white/15 object-contain p-1" />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/15 text-lg font-bold">
                          {company.name.charAt(0)}
                        </div>
                      )}
                      <div>
                        <p className="font-bold">{company.app_name || company.name}</p>
                        <p className="text-xs text-white/80">بريد {company.name}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "accounts" && (
            <EmptyState
              title="حسابات البريد"
              desc="سيتمكّن عملاؤك من إضافة حسابات IMAP/SMTP من هنا لاحقاً — سيُفعّل مع الخادم."
            />
          )}
          {tab === "users" && (
            <EmptyState
              title="المستخدمون"
              desc="أضف عملاء شركتك وأدر صلاحياتهم من هنا."
            />
          )}
        </main>
      </div>
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
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
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
    </div>
  );
}

function EmptyState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center shadow-soft">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}
