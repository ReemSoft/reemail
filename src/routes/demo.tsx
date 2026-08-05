import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Inbox,
  Star,
  Send,
  FileText,
  Trash2,
  Archive,
  ShieldAlert,
  Search,
  Paperclip,
  Lock,
} from "lucide-react";
import { tr } from "@/i18n";
import { useLanguage } from "@/hooks/use-language";
import { BrandLogo } from "@/components/brand-logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ArrowForward } from "@/components/ui/directional-icon";
import { getMessages, getFolderCounts, formatDate, formatSize } from "@/lib/mail-mock";
import type { MailFolder, MailMessage } from "@/lib/mail-types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "تجربة الواجهة | MailMaestro" },
      {
        name: "description",
        content:
          "جرّب واجهة MailMaestro مباشرة ببيانات تجريبية للقراءة فقط — بدون تسجيل دخول وبدون ربط أي حساب بريد.",
      },
      { property: "og:title", content: "تجربة واجهة MailMaestro" },
      {
        property: "og:description",
        content: "معاينة تفاعلية لواجهة البريد بسرعة البرق ببيانات تجريبية، بدون تسجيل.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "index, follow" },
    ],
  }),
  component: DemoMailbox,
});

const FOLDERS: { key: MailFolder; label: string; icon: typeof Inbox }[] = [
  { key: "inbox", label: "الوارد", icon: Inbox },
  { key: "starred", label: "المميزة بنجمة", icon: Star },
  { key: "sent", label: "المرسلة", icon: Send },
  { key: "drafts", label: "المسودات", icon: FileText },
  { key: "archive", label: "الأرشيف", icon: Archive },
  { key: "spam", label: "المزعج", icon: ShieldAlert },
  { key: "trash", label: "المهملات", icon: Trash2 },
];

function initials(name: string) {
  return name.trim().charAt(0).toUpperCase();
}

function DemoMailbox() {
  const { lang } = useLanguage();
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());

  const counts = useMemo(() => getFolderCounts(), []);
  const messages = useMemo(() => {
    const list = getMessages(folder);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.name.toLowerCase().includes(q) ||
        m.from.email.toLowerCase().includes(q) ||
        m.preview.toLowerCase().includes(q),
    );
  }, [folder, query]);

  const open: MailMessage | null = useMemo(
    () => messages.find((m) => m.id === openId) ?? null,
    [messages, openId],
  );

  const unreadFor = (key: MailFolder) =>
    counts.find((c) => c.folder === key)?.unread ?? 0;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Demo banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-brand-gradient px-4 py-2 text-sm text-white">
        <span className="flex items-center gap-2">
          <Lock className="h-4 w-4" />
          {tr("وضع تجريبي للقراءة فقط — بيانات وهمية، لا يوجد أي اتصال بحساب بريد حقيقي.")}
        </span>
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 font-semibold backdrop-blur transition hover:bg-white/25"
        >
          {tr("ابدأ ببريدك الحقيقي")}
          <ArrowForward className="h-4 w-4" />
        </Link>
      </div>

      {/* Top bar */}
      <header className="flex h-11 items-center justify-between border-b border-border px-4">
        <Link to="/" className="flex items-center gap-2">
          <BrandLogo className="h-6 w-6" />
          <span className="text-sm font-bold">MailMaestro</span>
        </Link>
        <div className="relative w-full max-w-md px-4">
          <Search className="pointer-events-none absolute inset-y-0 my-auto h-4 w-4 text-muted-foreground ltr:left-7 rtl:right-7" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("ابحث في الرسائل")}
            className="h-8 w-full rounded-lg border border-border bg-surface px-9 text-sm outline-none focus:border-brand-accent"
          />
        </div>
        <LanguageSwitcher />
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        {/* Folders */}
        <aside className="border-b border-border p-2 md:w-56 md:shrink-0 md:border-b-0 md:border-e">
          <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {FOLDERS.map((f) => {
              const active = folder === f.key;
              const unread = unreadFor(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => {
                    setFolder(f.key);
                    setOpenId(null);
                  }}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition md:w-full",
                    active
                      ? "bg-accent font-semibold text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  <f.icon className="h-4 w-4" />
                  <span className="flex-1 text-start">{tr(f.label)}</span>
                  {unread > 0 && (
                    <span className="rounded-full bg-brand-gradient px-1.5 text-[11px] font-semibold text-white">
                      {unread}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* List */}
        <section
          className={cn(
            "border-border md:w-[22rem] md:shrink-0 md:border-e",
            open ? "hidden md:block" : "block",
          )}
        >
          {messages.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {tr("لا توجد رسائل هنا")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {messages.map((m) => {
                const isRead = m.read || readIds.has(m.id);
                const active = openId === m.id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenId(m.id);
                        setReadIds((prev) => new Set(prev).add(m.id));
                      }}
                      className={cn(
                        "flex w-full items-start gap-3 px-4 py-3 text-start transition hover:bg-muted/60",
                        active && "bg-accent/60",
                      )}
                    >
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-xs font-bold text-white">
                        {initials(m.from.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              "truncate text-sm",
                              isRead ? "text-muted-foreground" : "font-semibold text-foreground",
                            )}
                          >
                            {m.from.name}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatDate(m.date, lang)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "mt-0.5 block truncate text-sm",
                            isRead ? "text-muted-foreground" : "font-medium text-foreground",
                          )}
                        >
                          {m.subject}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          {m.hasAttachments && <Paperclip className="h-3 w-3 shrink-0" />}
                          <span className="truncate">{m.preview}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Reading pane */}
        <section className={cn("flex-1 bg-surface", open ? "block" : "hidden md:block")}>
          {!open ? (
            <div className="flex h-full min-h-[24rem] flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
              <BrandLogo className="h-12 w-12 opacity-60" />
              <p className="text-sm">{tr("اختر رسالة لعرضها")}</p>
            </div>
          ) : (
            <article className="mx-auto max-w-3xl p-4 sm:p-8">
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="mb-4 text-sm text-muted-foreground hover:text-foreground md:hidden"
              >
                {tr("رجوع")}
              </button>
              <h1 className="text-xl font-bold leading-snug">{open.subject}</h1>
              <div className="mt-4 flex items-center gap-3 border-b border-border pb-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
                  {initials(open.from.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{open.from.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{open.from.email}</p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(open.date, lang)}
                </span>
              </div>
              <div
                className="prose prose-sm mt-6 max-w-none text-foreground [&_a]:text-brand-accent"
                // Static demo content shipped with the app — no user/remote HTML.
                dangerouslySetInnerHTML={{ __html: open.body }}
              />
              {open.attachments?.length ? (
                <div className="mt-8 border-t border-border pt-4">
                  <p className="mb-2 text-xs font-semibold text-muted-foreground">
                    {tr("المرفقات")}
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {open.attachments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
                      >
                        <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{a.filename}</span>
                        <span className="text-muted-foreground">{formatSize(a.size)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="mt-8 rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
                {tr("هذه رسالة تجريبية. الرد والإرسال والحذف متاحة بعد ربط بريدك الحقيقي.")}
              </p>
            </article>
          )}
        </section>
      </div>
    </div>
  );
}
