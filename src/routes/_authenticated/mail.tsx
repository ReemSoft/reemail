import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Inbox,
  Star,
  Send,
  FileText,
  Trash2,
  Archive,
  AlertOctagon,
  Search,
  Menu,
  X,
  Pencil,
  Paperclip,
  ArrowLeft,
  RefreshCw,
  MoreVertical,
  LogOut,
  Settings,
  Mail as MailIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCompanyTheme } from "@/hooks/use-company-theme";
import {
  MOCK_MESSAGES,
  getMessages,
  getMessage,
  getFolderCounts,
  formatDate,
  formatSize,
} from "@/lib/mail-mock";
import type { MailFolder, MailMessage } from "@/lib/mail-types";

export const Route = createFileRoute("/_authenticated/mail")({
  head: () => ({
    meta: [{ title: "صندوق الوارد — Reemsoft Mail" }],
  }),
  component: MailApp,
});

const FOLDER_META: Record<MailFolder, { label: string; icon: typeof Inbox }> = {
  inbox: { label: "الوارد", icon: Inbox },
  starred: { label: "المميّزة", icon: Star },
  sent: { label: "المرسلة", icon: Send },
  drafts: { label: "المسودّات", icon: FileText },
  spam: { label: "المزعجة", icon: AlertOctagon },
  trash: { label: "المهملات", icon: Trash2 },
  archive: { label: "الأرشيف", icon: Archive },
  all: { label: "الكل", icon: MailIcon },
};

function MailApp() {
  // Demo brand — later replaced by loaded company brand.
  useCompanyTheme({ primary: "#0F172A", accent: "#3B82F6" });

  const navigate = useNavigate();
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  const counts = useMemo(() => getFolderCounts(), []);
  const messages = useMemo(() => {
    const base = getMessages(folder);
    if (!query.trim()) return base;
    const q = query.toLowerCase();
    return base.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.name.toLowerCase().includes(q) ||
        m.from.email.toLowerCase().includes(q) ||
        m.preview.toLowerCase().includes(q),
    );
  }, [folder, query]);

  const selected = selectedId ? getMessage(selectedId) : null;

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  return (
    <div className="flex h-screen w-full flex-col bg-background">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4">
        <button
          onClick={() => setSidebarOpen((s) => !s)}
          className="rounded-lg p-2 hover:bg-muted lg:hidden"
          aria-label="القائمة"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link to="/mail" className="flex shrink-0 items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient text-white">
            <MailIcon className="h-4 w-4" />
          </div>
          <span className="hidden text-base font-bold sm:inline">Reemsoft Mail</span>
        </Link>

        <div className="mx-2 flex flex-1 items-center gap-2 rounded-xl bg-muted/70 px-3 py-2 transition focus-within:bg-card focus-within:shadow-elevated sm:mx-4 sm:max-w-2xl">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث في البريد..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <button
          onClick={() => window.location.reload()}
          className="hidden rounded-lg p-2 hover:bg-muted sm:inline-flex"
          aria-label="تحديث"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <Link to="/company" className="hidden rounded-lg p-2 hover:bg-muted sm:inline-flex">
          <Settings className="h-4 w-4" />
        </Link>
        <button
          onClick={handleSignOut}
          className="rounded-lg p-2 hover:bg-muted"
          aria-label="خروج"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 right-0 top-14 z-30 w-64 shrink-0 transform border-l border-border bg-sidebar transition-transform lg:relative lg:top-0 lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0" : "translate-x-full lg:translate-x-0"
          }`}
        >
          <div className="p-4">
            <button
              onClick={() => {
                setComposeOpen(true);
                setSidebarOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-2xl bg-brand-gradient px-5 py-3.5 text-sm font-semibold text-white shadow-brand transition hover:scale-[1.02]"
            >
              <Pencil className="h-4 w-4" />
              رسالة جديدة
            </button>
          </div>

          <nav className="px-2">
            {counts.map(({ folder: f, unread }) => {
              const meta = FOLDER_META[f];
              const active = f === folder;
              const Icon = meta.icon;
              return (
                <button
                  key={f}
                  onClick={() => {
                    setFolder(f);
                    setSelectedId(null);
                    setSidebarOpen(false);
                  }}
                  className={`mb-0.5 flex w-full items-center gap-3 rounded-r-full rounded-l-md px-4 py-2.5 text-sm transition ${
                    active
                      ? "bg-sidebar-hover font-semibold text-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-hover/60"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${active ? "text-primary" : ""}`} />
                  <span className="flex-1 text-right">{meta.label}</span>
                  {unread > 0 && (
                    <span
                      className={`rounded-full px-1.5 text-[11px] font-bold ${
                        active ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {unread}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mx-4 mt-6 border-t border-border pt-4">
            <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              التخزين
            </p>
            <div className="px-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/4 rounded-full bg-brand-gradient" />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">2.4 / 10 جيجابايت</p>
            </div>
          </div>
        </aside>

        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 top-14 z-20 bg-black/40 lg:hidden"
          />
        )}

        {/* Message list */}
        <div
          className={`flex w-full flex-col border-l border-border bg-card md:w-96 md:shrink-0 ${
            selected ? "hidden md:flex" : "flex"
          }`}
        >
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4 text-xs">
            <span className="font-semibold text-muted-foreground">
              {FOLDER_META[folder].label} · {messages.length}
            </span>
            <button className="rounded-md p-1 hover:bg-muted">
              <MoreVertical className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MailIcon className="h-10 w-10 opacity-30" />
                <p className="text-sm">لا توجد رسائل هنا</p>
              </div>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  active={m.id === selectedId}
                  onClick={() => setSelectedId(m.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Message viewer */}
        <div
          className={`flex-1 overflow-hidden bg-surface ${
            selected ? "flex" : "hidden md:flex"
          } flex-col`}
        >
          {selected ? (
            <MessageView
              message={selected}
              onBack={() => setSelectedId(null)}
              onReply={() => setComposeOpen(true)}
            />
          ) : (
            <EmptyViewer />
          )}
        </div>
      </div>

      {composeOpen && <Composer onClose={() => setComposeOpen(false)} />}
    </div>
  );
}

function MessageRow({
  message,
  active,
  onClick,
}: {
  message: MailMessage;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-right transition hover:bg-muted/50 ${
        active ? "bg-accent" : ""
      } ${!message.read ? "bg-card" : "bg-card/70"}`}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white`}
      >
        {message.from.name.charAt(0)}
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="mb-0.5 flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${
              !message.read ? "font-bold text-foreground" : "font-medium text-foreground/80"
            }`}
          >
            {message.from.name}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatDate(message.date)}
          </span>
        </div>
        <p
          className={`truncate text-sm ${
            !message.read ? "font-semibold text-foreground" : "text-muted-foreground"
          }`}
        >
          {message.subject}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{message.preview}</p>
        <div className="mt-1 flex items-center gap-2">
          {message.starred && <Star className="h-3 w-3 fill-star text-star" />}
          {message.hasAttachments && <Paperclip className="h-3 w-3 text-muted-foreground" />}
          {message.labels?.map((l) => (
            <span
              key={l}
              className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground"
            >
              {l}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

function MessageView({
  message,
  onBack,
  onReply,
}: {
  message: MailMessage;
  onBack: () => void;
  onReply: () => void;
}) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
        >
          <ArrowLeft className="h-4 w-4" /> رجوع
        </button>
        <div className="hidden gap-1 md:flex">
          <button className="rounded-lg p-2 hover:bg-muted" title="أرشفة">
            <Archive className="h-4 w-4" />
          </button>
          <button className="rounded-lg p-2 hover:bg-muted" title="حذف">
            <Trash2 className="h-4 w-4" />
          </button>
          <button className="rounded-lg p-2 hover:bg-muted" title="مزعج">
            <AlertOctagon className="h-4 w-4" />
          </button>
        </div>
        <button className="rounded-lg p-2 hover:bg-muted">
          <MoreVertical className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6 sm:p-8">
          <h1 className="text-2xl font-bold leading-snug text-foreground sm:text-3xl">
            {message.subject}
          </h1>
          <div className="mt-6 flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
              {message.from.name.charAt(0)}
            </div>
            <div className="flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-semibold text-foreground">{message.from.name}</span>{" "}
                  <span className="text-sm text-muted-foreground" dir="ltr">
                    &lt;{message.from.email}&gt;
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(message.date).toLocaleString("ar-SA")}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                إلى: {message.to.map((t) => t.name).join("، ")}
              </p>
            </div>
          </div>

          <div
            className="prose prose-sm mt-6 max-w-none text-foreground/90 [&_ul]:list-disc [&_ul]:pr-5"
            dangerouslySetInnerHTML={{ __html: message.body }}
          />

          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-8 border-t border-border pt-4">
              <p className="mb-3 text-sm font-semibold">
                المرفقات ({message.attachments.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {message.attachments.map((a) => (
                  <button
                    key={a.id}
                    className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-soft transition hover:border-primary hover:shadow-elevated"
                  >
                    <Paperclip className="h-4 w-4 text-muted-foreground" />
                    <span>{a.filename}</span>
                    <span className="text-xs text-muted-foreground">({formatSize(a.size)})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-8 flex gap-2">
            <button
              onClick={onReply}
              className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium shadow-soft hover:border-primary"
            >
              رد
            </button>
            <button className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium shadow-soft hover:border-primary">
              رد للكل
            </button>
            <button className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium shadow-soft hover:border-primary">
              إعادة توجيه
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function EmptyViewer() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-brand-gradient/10">
        <MailIcon className="h-10 w-10 text-brand-accent" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">اختر رسالة للاطّلاع</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {MOCK_MESSAGES.filter((m) => !m.read).length} رسالة غير مقروءة في بريدك
        </p>
      </div>
    </div>
  );
}

function Composer({ onClose }: { onClose: () => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 sm:inset-auto sm:bottom-4 sm:right-4">
      <div className="mx-auto flex h-[75vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-float sm:rounded-2xl">
        <div className="flex items-center justify-between bg-brand-gradient px-4 py-3 text-white">
          <span className="text-sm font-semibold">رسالة جديدة</span>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-white/15">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="إلى"
            className="w-full border-b border-border bg-transparent py-2 text-sm outline-none focus:border-primary"
            dir="ltr"
          />
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="الموضوع"
            className="mt-2 w-full border-b border-border bg-transparent py-2 text-sm outline-none focus:border-primary"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="اكتب رسالتك..."
            className="mt-4 h-full min-h-40 w-full resize-none bg-transparent text-sm outline-none"
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-3">
          <button className="rounded-lg p-2 hover:bg-muted">
            <Paperclip className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              onClose();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-5 py-2 text-sm font-semibold text-white shadow-soft hover:shadow-elevated"
          >
            <Send className="h-4 w-4" />
            إرسال
          </button>
        </div>
      </div>
    </div>
  );
}
