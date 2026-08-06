import { tr } from "@/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, Building2, LogIn } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ArrowBackward } from "@/components/ui/directional-icon";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { registerCompanyAdmin } from "@/lib/admin-signup.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/company")({
  head: () => ({
    meta: [
      { title: "بوابة الشركات — MailMaestro" },
      {
        name: "description",
        content:
          tr("سجّل شركتك على منصة MailMaestro أو ادخل إلى لوحة تحكم شركتك لإدارة إيميلات عملائك."),
      },
      { property: "og:title", content: "بوابة الشركات — MailMaestro" },
      {
        property: "og:description",
        content: "منصة SaaS لإدارة إيميلات الشركات وعملائها بسرعة البرق.",
      },
    ],
  }),
  component: CompanyPortalPage,
});

async function destinationForUser(userId: string): Promise<string> {
  const { data: roles } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const list = (roles ?? []).map((r) => r.role);
  if (list.includes("company_admin") || list.includes("super_admin"))
    return "/dashboard";
  return "/mail";
}

type Mode = "signin" | "register";

function CompanyPortalPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session) {
        const dest = await destinationForUser(data.session.user.id);
        navigate({ to: dest });
      } else {
        setCheckingSession(false);
      }
    });
  }, [navigate]);

  if (checkingSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <div className="relative hidden w-1/2 overflow-hidden bg-brand-gradient lg:block">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 30%, white 1px, transparent 1px), radial-gradient(circle at 80% 70%, white 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }}
        />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <Link to="/" className="inline-flex w-fit self-start items-center gap-1.5" dir="ltr">
            <BrandLogo className="h-10 w-10" />
            <span className="text-xl font-bold">MailMaestro</span>
          </Link>
          <div>
            <h2 className="text-4xl font-bold leading-tight">
              {tr("أدِر إيميلات")}
              <br />
              {tr("عملائك من مكان واحد")}
            </h2>
            <p className="mt-4 text-lg text-white/85">
              {tr("منصة بيضاء العلامة (White-label) لشركتك.")}
            </p>
          </div>
          <p className="text-sm text-white/70">
            © {new Date().getFullYear()} MailMaestro
          </p>
        </div>
      </div>

      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center justify-between">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowBackward className="h-4 w-4" /> {tr("العودة")}
            </Link>
            <LanguageSwitcher />
          </div>

          <div className="mb-8 grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-1.5">
            <button
              type="button"
              onClick={() => setMode("signin")}
              className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                mode === "signin"
                  ? "bg-brand-gradient text-white shadow-soft"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <LogIn className="h-4 w-4" /> {tr("دخول المدير")}
            </button>
            <button
              type="button"
              onClick={() => setMode("register")}
              className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                mode === "register"
                  ? "bg-brand-gradient text-white shadow-soft"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Building2 className="h-4 w-4" /> {tr("تسجيل شركة")}
            </button>
          </div>

          {mode === "signin" ? (
            <SignInForm />
          ) : (
            <RegisterCompanyForm onDone={() => setMode("signin")} />
          )}

          <div className="mt-8 rounded-xl border border-border bg-card p-4 text-center text-sm">
            <p className="text-muted-foreground">{tr("هل أنت عميل تريد فتح بريدك؟")}</p>
            <Link
              to="/login"
              className="mt-1 inline-block font-semibold text-primary hover:underline"
            >
              {tr("دخول العملاء ←")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function SignInForm() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { data: signIn, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      const dest = await destinationForUser(signIn.user!.id);
      toast.success(tr("مرحباً بعودتك 👋"));
      navigate({ to: dest });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : tr("حدث خطأ غير متوقع");
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">{tr("دخول مدير الشركة")}</h1>
      <p className="mt-2 text-muted-foreground">
        {tr("سجّل دخولك للوصول إلى لوحة تحكم شركتك.")}
      </p>
      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <Field
          label={tr("البريد الإلكتروني")}
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@company.com"
          required
        />
        <Field
          label={tr("كلمة المرور")}
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
          minLength={6}
          required
        />
        <SubmitButton loading={loading}>{tr("تسجيل الدخول")}</SubmitButton>
      </form>
    </>
  );
}

function RegisterCompanyForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const register = useServerFn(registerCompanyAdmin);
  const [companyName, setCompanyName] = useState("");
  const [companySlug, setCompanySlug] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  function handleNameChange(v: string) {
    setCompanyName(v);
    const auto = v
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40);
    if (
      auto &&
      (companySlug === "" || companySlug === v.slice(0, companySlug.length))
    ) {
      setCompanySlug(auto);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await register({
        data: {
          company_name: companyName,
          company_slug: companySlug,
          full_name: fullName,
          email,
          password,
        },
      });
      const { error: signErr } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signErr) {
        toast.success(tr("تم إنشاء الشركة. سجّل الدخول الآن."));
        onDone();
        return;
      }
      toast.success(tr("مرحباً بك! جاري تجهيز لوحة التحكم…"));
      navigate({ to: "/dashboard" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : tr("حدث خطأ غير متوقع");
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">{tr("سجّل شركتك")}</h1>
      <p className="mt-2 text-muted-foreground">
        {tr("أنشئ حساب شركتك في دقيقة، ثم أضف إيميلات عملائك.")}
      </p>
      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <Field
          label={tr("اسم الشركة")}
          type="text"
          value={companyName}
          onChange={handleNameChange}
          placeholder={tr("مثال: MailMaestro")}
          required
        />
        <Field
          label={tr("معرّف الشركة (بالإنجليزية)")}
          type="text"
          value={companySlug}
          onChange={(v) =>
            setCompanySlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))
          }
          placeholder="mailmaestro"
          minLength={3}
          maxLength={40}
          required
          ltr
        />
        <Field
          label={tr("اسمك الكامل")}
          type="text"
          value={fullName}
          onChange={setFullName}
          placeholder={tr("محمد أحمد")}
          required
        />
        <Field
          label={tr("بريدك الإلكتروني")}
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@company.com"
          required
        />
        <Field
          label={tr("كلمة المرور")}
          type="password"
          value={password}
          onChange={setPassword}
          placeholder={tr("6 أحرف على الأقل")}
          minLength={6}
          required
        />
        <SubmitButton loading={loading}>{tr("إنشاء الشركة")}</SubmitButton>
      </form>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        {tr("بالتسجيل أنت توافق على شروط الاستخدام.")}
      </p>
    </>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  required,
  minLength,
  maxLength,
  ltr,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  ltr?: boolean;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        type={type}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        dir={ltr || type === "email" || type === "password" ? "ltr" : undefined}
        className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </div>
  );
}

function SubmitButton({
  loading,
  children,
}: {
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated disabled:opacity-60"
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
