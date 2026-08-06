import { tr } from "@/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ArrowBackward } from "@/components/ui/directional-icon";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { clientLogin } from "@/lib/client-mail.functions";
import { saveMailSession, getMailSession } from "@/lib/mail-session";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "دخول العملاء — MailMaestro" },
      {
        name: "description",
        content: "بوابة دخول العملاء إلى بريدهم الإلكتروني عبر منصة MailMaestro.",
      },
      { property: "og:title", content: "دخول العملاء — MailMaestro" },
      {
        property: "og:description",
        content: "افتح بريدك الإلكتروني بسرعة البرق.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const login = useServerFn(clientLogin);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // If already unlocked, jump straight to mail.
    if (getMailSession()) navigate({ to: "/mail" });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await login({ data: { email, password } });
      if (!result.ok) {
        toast.error(tr(result.message ?? "تعذر تسجيل الدخول."));
        return;
      }

      saveMailSession({
        account: result.account,
        company: result.company,
        password,
        mailSessionToken: result.mailSessionToken,
        mailSessionTokenExpiresAt: result.mailSessionTokenExpiresAt,
      });
      toast.success(tr("تم فتح البريد ✨"));
      navigate({ to: "/mail" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : tr("بيانات الدخول غير صحيحة");
      toast.error(msg);
    } finally {
      setLoading(false);
    }
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
          <Link to="/" className="flex items-center gap-2.5">
            <BrandLogo variant="white" className="h-10 w-10 rounded-xl" />
            <span className="text-xl font-bold">MailMaestro</span>
          </Link>
          <div>
            <h2 className="text-4xl font-bold leading-tight">
              {tr("افتح بريدك")}
              <br />
              {tr("بسرعة البرق ⚡")}
            </h2>
            <p className="mt-4 text-lg text-white/85">
              {tr("أدخل بريدك وكلمة مروره فقط — لا حاجة لأي إعداد إضافي.")}
            </p>
          </div>
          <p className="text-sm text-white/70">© {new Date().getFullYear()} MailMaestro</p>
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

          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-gradient/10 text-brand-accent">
            <Lock className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{tr("افتح بريدك")}</h1>
          <p className="mt-2 text-muted-foreground">
            {tr("استخدم عنوان بريدك وكلمة مروره الحقيقية. كلمة المرور تُستخدم فقط في هذه الجلسة ولا تُخزَّن.")}
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                {tr("البريد الإلكتروني")}
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                dir="ltr"
                autoComplete="email"
                className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                {tr("كلمة مرور البريد")}
              </label>
              <input
                type="password"
                required
                minLength={3}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                dir="ltr"
                autoComplete="current-password"
                className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {tr("فتح البريد")}
            </button>
          </form>

          <div className="mt-8 rounded-xl border border-border bg-card p-4 text-center text-sm">
            <p className="text-muted-foreground">{tr("هل أنت صاحب شركة؟")}</p>
            <Link
              to="/company"
              className="mt-1 inline-block font-semibold text-primary hover:underline"
            >
              {tr("سجّل شركتك أو ادخل إلى لوحة التحكم ←")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
