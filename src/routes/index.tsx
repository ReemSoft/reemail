import { createFileRoute, Link } from "@tanstack/react-router";
import {
import { tr } from "@/i18n";
  Mail,
  Zap,
  Shield,
  Palette,
  Users,
  Cloud,
  ArrowLeft,
  CheckCircle2,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MailMaestro — منصة SaaS للبريد المؤسسي متعدد الشركات" },
      {
        name: "description",
        content:
          tr("افتح أي بريد إلكتروني بأداء عالٍ وسرعة البرق. منصة SaaS للشركات مع تخصيص كامل بالشعار والألوان لكل عميل."),
      },
      { property: "og:title", content: "MailMaestro — منصة SaaS للبريد المؤسسي متعدد الشركات" },
      {
        property: "og:description",
        content: "افتح أي بريد إلكتروني بأداء عالٍ وسرعة البرق. منصة SaaS للشركات مع تخصيص كامل بالشعار والألوان لكل عميل.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/60 glass">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient shadow-brand">
              <Mail className="h-5 w-5 text-white" />
            </div>
            <span className="text-lg font-bold tracking-tight">MailMaestro</span>
          </Link>
          <nav className="hidden items-center gap-8 md:flex">
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground">
              {tr("المزايا")}
            </a>
            <a href="#how" className="text-sm text-muted-foreground hover:text-foreground">
              {tr("كيف يعمل")}
            </a>
            <a href="#pricing" className="text-sm text-muted-foreground hover:text-foreground">
              {tr("الأسعار")}
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              to="/login"
              className="hidden rounded-lg px-4 py-2 text-sm font-medium text-foreground hover:bg-muted sm:inline-block"
            >
              {tr("تسجيل الدخول")}
            </Link>
            <Link
              to="/company"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft transition hover:shadow-elevated"
            >
              {tr("ابدأ مجاناً")}
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden px-4 pt-20 pb-24 sm:pt-28 sm:pb-32">
        <div
          className="absolute inset-0 -z-10 opacity-40"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, hsl(var(--brand-accent) / 0.25) 0%, transparent 100%)",
          }}
        />
        <div className="mx-auto max-w-4xl text-center animate-in-up">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-1.5 text-xs font-medium text-muted-foreground shadow-soft">
            <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {tr("منصة SaaS جاهزة لشركتك")}
          </div>
          <h1 className="text-balance text-4xl font-extrabold leading-tight tracking-tight text-foreground sm:text-6xl md:text-7xl">
            {tr("بريدك المؤسسي")}
            <br />
            <span className="bg-brand-gradient bg-clip-text text-transparent">
              {tr("بسرعة البرق")}
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-muted-foreground sm:text-xl">
            {tr("افتح أي حساب بريد إلكتروني عبر إعداداته البسيطة. لكل شركة شعارها وألوانها،
            ولكل عميل تجربة استخدام سلسة كأنها من صنع علامتك التجارية.")}
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/company"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-gradient px-6 py-3.5 text-base font-semibold text-white shadow-brand transition hover:scale-[1.02] sm:w-auto"
            >
              {tr("ابدأ تجربتك المجانية")}
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <Link
              to="/login"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 py-3.5 text-base font-semibold text-foreground shadow-soft transition hover:border-brand-accent sm:w-auto"
            >
              {tr("لدي حساب — دخول")}
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" /> {tr("بدون بطاقة ائتمانية")}
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" /> {tr("IMAP/SMTP قياسي")}
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" /> {tr("تخصيص كامل بالعلامة")}
            </span>
          </div>
        </div>

        {/* Screenshot mockup */}
        <div className="mx-auto mt-16 max-w-5xl">
          <div className="relative rounded-2xl border border-border bg-card p-2 shadow-float">
            <div className="rounded-xl bg-surface p-1">
              <div className="flex h-96 items-center justify-center rounded-lg bg-brand-gradient/5">
                <Link
                  to="/login"
                  className="rounded-xl bg-brand-gradient px-6 py-3 text-white shadow-brand"
                >
                  <span className="flex items-center gap-2">
                    <Mail className="h-5 w-5" /> {tr("افتح تجربة الواجهة")}
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border bg-surface px-4 py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              {tr("كل ما تحتاجه شركتك في مكان واحد")}
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              {tr("منصة كاملة للشركات لتقديم بريد إلكتروني احترافي لعملائها")}
            </p>
          </div>

          <div className="mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Zap,
                title: "أداء سرعة البرق",
                desc: tr("واجهة محسّنة تحمّل صندوق الوارد فوراً مع كاش ذكي وتحديثات فورية."),
              },
              {
                icon: Palette,
                title: "تخصيص كامل بالعلامة",
                desc: tr("شعارك، ألوانك، اسم التطبيق — كل شركة تظهر كتطبيق مصمّم خصيصاً لها."),
              },
              {
                icon: Shield,
                title: "أمان مؤسسي",
                desc: tr("تشفير AES-GCM لكل كلمات المرور، عزل تام بين بيانات الشركات."),
              },
              {
                icon: Users,
                title: "متعدد المستخدمين",
                desc: tr("لوحة تحكم لكل شركة لإدارة عملائها وحساباتهم بسهولة."),
              },
              {
                icon: Mail,
                title: "IMAP/SMTP قياسي",
                desc: tr("يعمل مع أي خادم بريد: Gmail، Outlook، cPanel، خوادم مخصصة."),
              },
              {
                icon: Cloud,
                title: "متجاوب لكل الشاشات",
                desc: tr("تجربة مثالية على الموبايل والتابلت والديسكتوب."),
              },
            ].map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-border bg-card p-6 shadow-soft transition hover:border-brand-accent/40 hover:shadow-elevated"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-foreground transition group-hover:bg-brand-gradient group-hover:text-white">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="pricing" className="px-4 py-24">
        <div className="mx-auto max-w-3xl rounded-3xl bg-brand-gradient p-10 text-center shadow-brand sm:p-16">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            {tr("جاهز لتقديم بريد إلكتروني احترافي لعملائك؟")}
          </h2>
          <p className="mt-4 text-lg text-white/85">
            {tr("سجّل الآن وابدأ خلال دقائق — بدون بطاقة ائتمانية.")}
          </p>
          <Link
            to="/company"
            className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 text-base font-semibold text-foreground shadow-elevated transition hover:scale-[1.02]"
          >
            {tr("ابدأ الآن مجاناً")}
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-border py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 text-sm text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} MailMaestro. جميع الحقوق محفوظة.</span>
          <div className="flex gap-6">
            <a href="#" className="hover:text-foreground">
              {tr("الخصوصية")}
            </a>
            <a href="#" className="hover:text-foreground">
              {tr("الشروط")}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
