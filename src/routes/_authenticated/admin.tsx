import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Building2, Users, Mail as MailIcon, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Company {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  brand_accent: string;
  created_at: string;
}

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [{ title: "لوحة المدير العام — Reemsoft Mail" }],
  }),
  component: AdminPanel,
});

function AdminPanel() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.user.id)
        .eq("role", "super_admin")
        .maybeSingle();
      const admin = !!roles;
      setIsAdmin(admin);
      if (admin) {
        const { data } = await supabase
          .from("companies")
          .select("*")
          .order("created_at", { ascending: false });
        setCompanies((data as Company[]) ?? []);
      }
    })();
  }, []);

  if (isAdmin === false) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div className="max-w-md rounded-2xl border border-border bg-card p-8 shadow-soft">
          <ShieldCheck className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="mt-4 text-xl font-bold">صلاحيات غير كافية</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            هذه الصفحة مخصّصة للمدير العام للمنصة. تواصل مع فريق الإدارة إذا كنت تحتاج للوصول.
          </p>
          <Link
            to="/mail"
            className="mt-6 inline-flex rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white"
          >
            العودة للبريد
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to="/mail" className="rounded-lg p-2 hover:bg-muted">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-lg font-bold">لوحة المدير العام</h1>
        </div>
      </header>

      <div className="mx-auto max-w-6xl p-4 md:p-8">
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <StatCard icon={Building2} label="الشركات" value={companies.length} />
          <StatCard icon={Users} label="المستخدمون" value={"—"} />
          <StatCard icon={MailIcon} label="الحسابات النشطة" value={"—"} />
        </div>

        <div className="rounded-2xl border border-border bg-card shadow-soft">
          <div className="border-b border-border p-4">
            <h2 className="font-bold">الشركات المسجّلة</h2>
          </div>
          {companies.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              لا توجد شركات مسجّلة بعد.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {companies.map((c) => (
                <li key={c.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold text-white"
                      style={{ background: c.brand_accent }}
                    >
                      {c.name.charAt(0)}
                    </div>
                    <div>
                      <p className="font-semibold">{c.name}</p>
                      <p className="text-xs text-muted-foreground" dir="ltr">
                        {c.slug}.reemsoft-mail.com
                      </p>
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      c.is_active
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {c.is_active ? "نشطة" : "معطّلة"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Building2;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-2xl font-bold">{value}</p>
    </div>
  );
}
