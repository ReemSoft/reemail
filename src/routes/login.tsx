import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Mail, ArrowLeft, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "دخول العملاء — Reemsoft Mail" },
      {
        name: "description",
        content:
          "بوابة دخول العملاء إلى بريدهم الإلكتروني عبر منصة Reemsoft Mail.",
      },
      { property: "og:title", content: "دخول العملاء — Reemsoft Mail" },
      {
        property: "og:description",
        content: "افتح بريدك الإلكتروني بسرعة البرق.",
      },
    ],
  }),
  component: LoginPage,
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

function LoginPage() {
  const navigate = useNavigate();
  const [checkingSession, setCheckingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

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
      toast.success("مرحباً بعودتك 👋");
      navigate({ to: dest });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "حدث خطأ غير متوقع";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

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
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
              <Mail className="h-5 w-5" />
            </div>
            <span className="text-xl font-bold">Reemsoft Mail</span>
          </Link>
          <div>
            <h2 className="text-4xl font-bold leading-tight">
              افتح بريدك
              <br />
              بسرعة البرق ⚡
            </h2>
            <p className="mt-4 text-lg text-white/85">
              دخول العملاء إلى بريدهم في ثوانٍ.
            </p>
          </div>
          <p className="text-sm text-white/70">
            © {new Date().getFullYear()} Reemsoft
          </p>
        </div>
      </div>

      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-md">
          <Link
            to="/"
            className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> العودة
          </Link>

          <h1 className="text-3xl font-bold tracking-tight">دخول العميل</h1>
          <p className="mt-2 text-muted-foreground">
            استخدم بيانات الدخول التي زوّدتك بها شركتك.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                البريد الإلكتروني
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                dir="ltr"
                className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                كلمة المرور
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                dir="ltr"
                className="w-full rounded-lg border border-input bg-card px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-gradient px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              تسجيل الدخول
            </button>
          </form>

          <div className="mt-8 rounded-xl border border-border bg-card p-4 text-center text-sm">
            <p className="text-muted-foreground">هل أنت صاحب شركة؟</p>
            <Link
              to="/company"
              className="mt-1 inline-block font-semibold text-primary hover:underline"
            >
              سجّل شركتك أو ادخل إلى لوحة التحكم ←
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
