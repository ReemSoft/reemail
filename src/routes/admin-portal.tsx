import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ShieldCheck, ArrowLeft, Loader2, LogOut } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { registerCompanyAdmin } from "@/lib/admin-signup.functions";

type AdminDestination = "/admin" | "/company" | "/mail";

interface ExistingSession {
  email: string;
  destination: AdminDestination;
}

export const Route = createFileRoute("/admin-portal")({
  head: () => ({
    meta: [
      { title: "دخول المدراء — Reemsoft Mail" },
      { name: "description", content: "بوابة مدراء الشركات لإدارة بريد عملائهم." },
      { property: "og:title", content: "دخول المدراء — Reemsoft Mail" },
      { property: "og:description", content: "بوابة مدراء الشركات لإدارة بريد عملائهم." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AdminPortal,
});

async function routeByRole(userId: string): Promise<AdminDestination> {
  const { data: roles } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const list = (roles ?? []).map((r) => r.role);
  if (list.includes("super_admin")) return "/admin";
  if (list.includes("company_admin")) return "/company";
  return "/mail";
}

function destinationLabel(destination: AdminDestination) {
  if (destination === "/admin") return "لوحة المدير العام";
  if (destination === "/company") return "لوحة تحكم الشركة";
  return "بريد العميل";
}

function AdminPortal() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companySlug, setCompanySlug] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [existingSession, setExistingSession] = useState<ExistingSession | null>(null);
  const register = useServerFn(registerCompanyAdmin);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session) {
        const dest = await routeByRole(data.session.user.id);
        setExistingSession({
          email: data.session.user.email ?? "حساب مسجّل",
          destination: dest,
        });
      }
      setCheckingSession(false);
    });
  }, []);

  async function handleSignOut() {
    setLoading(true);
    await supabase.auth.signOut();
    setExistingSession(null);
    setLoading(false);
    toast.success("تم تسجيل الخروج. يمكنك الآن إنشاء/دخول حساب مدير آخر.");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        await register({
          data: {
            company_name: companyName,
            company_slug: companySlug.toLowerCase().trim(),
            email,
            password,
            full_name: fullName,
          },
        });
        // auto sign in
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("تم إنشاء شركتك! جارٍ تحويلك إلى لوحة التحكم...");
        navigate({ to: "/company" });
      } else {
        const { data: signIn, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        const dest = await routeByRole(signIn.user!.id);
        if (dest === "/mail") {
          await supabase.auth.signOut();
          throw new Error("هذا الحساب ليس حساب مدير. استخدم بوابة العملاء.");
        }
        toast.success("مرحباً 👋");
        navigate({ to: dest });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "حدث خطأ";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> العودة
        </Link>

        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-soft">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">بوابة المدراء</h1>
            <p className="text-sm text-muted-foreground">
              {mode === "signup"
                ? "أنشئ شركتك وابدأ بإدارة بريد عملائك"
                : "سجّل الدخول إلى لوحة تحكم شركتك"}
            </p>
          </div>
        </div>

        {checkingSession ? (
          <div className="flex items-center justify-center rounded-2xl border border-border bg-card p-8 shadow-soft">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : existingSession ? (
          <div className="rounded-2xl border border-border bg-card p-6 shadow-soft">
            <p className="text-sm text-muted-foreground">أنت مسجّل دخول حالياً بهذا الحساب:</p>
            <p className="mt-2 font-semibold" dir="ltr">{existingSession.email}</p>
            <p className="mt-4 text-sm text-muted-foreground">
              لذلك لن أحوّلك تلقائياً. اختر وجهتك أو سجّل الخروج لاستخدام حساب مدير آخر.
            </p>
            <div className="mt-6 grid gap-3">
              <button
                type="button"
                onClick={() => navigate({ to: existingSession.destination })}
                className="inline-flex items-center justify-center rounded-lg bg-brand-gradient px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated"
              >
                الذهاب إلى {destinationLabel(existingSession.destination)}
              </button>
              {existingSession.destination === "/mail" && (
                <Link
                  to="/auth"
                  className="inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-muted"
                >
                  رابط دخول العملاء
                </Link>
              )}
              <button
                type="button"
                onClick={handleSignOut}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-60"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                تسجيل الخروج من هذا الحساب
              </button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-soft">
          {mode === "signup" && (
            <>
              <Field label="اسم الشركة">
                <input
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="مثلاً: شركة النور"
                  className="input"
                />
              </Field>
              <Field label="المعرّف (باللغة الإنجليزية، للرابط)">
                <input
                  type="text"
                  required
                  value={companySlug}
                  onChange={(e) => setCompanySlug(e.target.value)}
                  placeholder="alnoor"
                  dir="ltr"
                  className="input"
                />
              </Field>
              <Field label="اسمك الكامل">
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="محمد أحمد"
                  className="input"
                />
              </Field>
            </>
          )}
          <Field label="البريد الإلكتروني">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@company.com"
              dir="ltr"
              className="input"
            />
          </Field>
          <Field label="كلمة المرور">
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              dir="ltr"
              className="input"
            />
          </Field>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "signup" ? "إنشاء الشركة والحساب" : "دخول المدير"}
          </button>
        </form>
        )}

        {!checkingSession && !existingSession && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signup" ? "لديك حساب مدير بالفعل؟ " : "شركة جديدة؟ "}
            <button
              onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
              className="font-semibold text-primary hover:underline"
            >
              {mode === "signup" ? "سجّل الدخول" : "أنشئ حساب مدير"}
            </button>
          </p>
        )}

        <style>{`
          .input { width: 100%; border-radius: 0.5rem; border: 1px solid hsl(var(--input)); background: hsl(var(--card)); padding: 0.625rem 1rem; font-size: 0.875rem; outline: none; transition: all .15s; }
          .input:focus { border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.2); }
        `}</style>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}
