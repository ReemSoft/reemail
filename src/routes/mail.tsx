import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Virtuoso } from "react-virtuoso";

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
  Mail as MailIcon,
  Loader2,
  ChevronLeft,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useCompanyTheme } from "@/hooks/use-company-theme";
import {
  bridgeGetFolderCounts,
  bridgeGetMessages,
  bridgeGetMessage,
  bridgeMarkRead,
  bridgeStar,
  bridgeMove,
  bridgeDelete,
  bridgeSend,
} from "@/lib/mail-bridge.functions";
import {
  formatDate,
  formatSize,
  getFolderCounts as getMockFolderCounts,
  getMessages as getMockMessages,
  getMessage as getMockMessage,
} from "@/lib/mail-mock";
import type { MailFolder, MailMessage } from "@/lib/mail-types";
import {
  clearMailSession,
  getMailSession,
  type MailSession,
} from "@/lib/mail-session";

export const Route = createFileRoute("/mail")({
  ssr: false,
  head: () => ({
    meta: [{ title: "صندوق الوارد — MailMaestro" }],
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

function parseMessageId(id: string): { folder: MailFolder; uid: number } | null {
  const [folder, uidStr] = id.split(":");
  const uid = Number(uidStr);
  if (!folder || !uidStr || Number.isNaN(uid)) return null;
  return { folder: folder as MailFolder, uid };
}

function useMailData(session: MailSession | null) {
  const getCounts = useServerFn(bridgeGetFolderCounts);
  const getMessages = useServerFn(bridgeGetMessages);
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [counts, setCounts] = useState<Record<MailFolder, { total: number; unread: number }>>({
    inbox: { total: 0, unread: 0 },
    starred: { total: 0, unread: 0 },
    sent: { total: 0, unread: 0 },
    drafts: { total: 0, unread: 0 },
    spam: { total: 0, unread: 0 },
    trash: { total: 0, unread: 0 },
    archive: { total: 0, unread: 0 },
    all: { total: 0, unread: 0 },
  });
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [useMock, setUseMock] = useState(false);

  const loadCounts = useCallback(async () => {
    if (!session) return;
    try {
      const result = await getCounts({ data: { account: session.account, password: session.password } });
      const map: Record<MailFolder, { total: number; unread: number }> = {
        inbox: { total: 0, unread: 0 },
        starred: { total: 0, unread: 0 },
        sent: { total: 0, unread: 0 },
        drafts: { total: 0, unread: 0 },
        spam: { total: 0, unread: 0 },
        trash: { total: 0, unread: 0 },
        archive: { total: 0, unread: 0 },
        all: { total: 0, unread: 0 },
      };
      if (!result.ok) throw new Error(result.error);
      result.counts.forEach((c) => (map[c.folder] = { total: c.total, unread: c.unread }));
      setCounts(map);
      setBridgeError(null);
    } catch (err: any) {
      setBridgeError(err?.message || "فشل الاتصال بخادم البريد");
      setCounts(Object.fromEntries(getMockFolderCounts().map((c) => [c.folder, { total: c.total, unread: c.unread }])) as Record<MailFolder, { total: number; unread: number }>);
    }
  }, [session, getCounts]);

  const loadMessages = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const result = await getMessages({
        data: { account: session.account, password: session.password, folder },
      });
      if (!result.ok) throw new Error(result.error);
      setMessages(result.messages);
      setBridgeError(null);
      setUseMock(false);
    } catch (err: any) {
      setBridgeError(err?.message || "فشل جلب الرسائل");
      setMessages(getMockMessages(folder));
      setUseMock(true);
    } finally {
      setLoading(false);
    }

  }, [session, folder, getMessages]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  return {
    folder,
    setFolder,
    counts,
    messages,
    setMessages,
    loading,
    bridgeError,
    useMock,
    refresh: () => {
      loadCounts();
      loadMessages();
    },
  };
}

function MailApp() {
  const navigate = useNavigate();
  const [session, setSession] = useState<MailSession | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);
  const [reading, setReading] = useState(false);

  const { folder, setFolder, counts, messages, setMessages, loading, bridgeError, useMock, refresh } =
    useMailData(session || null);

  const getOne = useServerFn(bridgeGetMessage);
  const markRead = useServerFn(bridgeMarkRead);
  const star = useServerFn(bridgeStar);
  const move = useServerFn(bridgeMove);
  const deleteFn = useServerFn(bridgeDelete);

  useCompanyTheme(
    session?.company
      ? { primary: session.company.brand_primary, accent: session.company.brand_accent }
      : { primary: "#0F172A", accent: "#3B82F6" },
  );

  useEffect(() => {
    const s = getMailSession();
    if (!s) {
      navigate({ to: "/login" });
      return;
    }
    setSession(s);
  }, [navigate]);

  const filteredMessages = useMemo(() => {
    if (!query.trim()) return messages;
    const q = query.toLowerCase();
    return messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.name.toLowerCase().includes(q) ||
        m.from.email.toLowerCase().includes(q) ||
        m.preview.toLowerCase().includes(q),
    );
  }, [messages, query]);

  async function openMessage(id: string) {
    setSelectedId(id);
    const parsed = parseMessageId(id);
    if (!parsed || !session) {
      setSelectedMessage(getMockMessage(id) ?? null);
      return;
    }
    setReading(true);
    try {
      const result = await getOne({
        data: { account: session.account, password: session.password, folder: parsed.folder, uid: parsed.uid },
      });
      if (!result.ok) throw new Error(result.error);
      setSelectedMessage(result.message);
      if (result.message && !result.message.read) {

        await markRead({
          data: { account: session.account, password: session.password, folder: parsed.folder, uid: parsed.uid, read: true },
        });
        // Optimistically update local read state
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: true } : m)));
      }
    } catch (err: any) {
      toast.error(err?.message || "فشل فتح الرسالة");
      setSelectedMessage(getMockMessage(id) ?? null);
    } finally {
      setReading(false);
    }
  }

  async function toggleStar(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    const msg = messages.find((m) => m.id === id);
    const nextStarred = !msg?.starred;
    try {
      await star({
        data: {
          account: session.account,
          password: session.password,
          folder: parsed.folder,
          uid: parsed.uid,
          starred: nextStarred,
        },
      });
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, starred: nextStarred } : m)));
    } catch (err: any) {
      toast.error(err?.message || "فشل تحديث المميّز");
    }
  }

  async function handleMove(id: string, toFolder: MailFolder) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    try {
      await move({
        data: {
          account: session.account,
          password: session.password,
          folder: parsed.folder,
          uid: parsed.uid,
          toFolder,
        },
      });
      toast.success("تم نقل الرسالة");
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setSelectedId(null);
      setSelectedMessage(null);
    } catch (err: any) {
      toast.error(err?.message || "فشل نقل الرسالة");
    }
  }

  async function handleDelete(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    try {
      await deleteFn({
        data: { account: session.account, password: session.password, folder: parsed.folder, uid: parsed.uid },
      });
      toast.success("تم حذف الرسالة");
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setSelectedId(null);
      setSelectedMessage(null);
    } catch (err: any) {
      toast.error(err?.message || "فشل حذف الرسالة");
    }
  }

  function handleSignOut() {
    clearMailSession();
    navigate({ to: "/login" });
  }

  if (session === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!session) return null;

  const brandName = session.company?.app_name || session.company?.name || "MailMaestro";

  return (
    <div className="flex h-screen w-full flex-col bg-background">
      {bridgeError && (
        <div className="flex items-center justify-center gap-2 bg-warning px-3 py-2 text-xs font-medium text-warning-foreground">
          <AlertOctagon className="h-4 w-4" />
          <span>{bridgeError}</span>
          {useMock && <span className="opacity-80">(يتم عرض بيانات تجريبية مؤقتًا)</span>}
        </div>
      )}

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
          {session.company?.logo_url ? (
            <img
              src={session.company.logo_url}
              alt={brandName}
              className="h-8 w-8 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient text-white">
              <MailIcon className="h-4 w-4" />
            </div>
          )}
          <span className="hidden text-base font-bold sm:inline">{brandName}</span>
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
          onClick={refresh}
          className="hidden rounded-lg p-2 hover:bg-muted sm:inline-flex"
          aria-label="تحديث"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <div
          className="hidden max-w-[180px] truncate rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground sm:inline-block"
          dir="ltr"
          title={session.account.email_address}
        >
          {session.account.email_address}
        </div>
        <button
          onClick={handleSignOut}
          className="rounded-lg p-2 hover:bg-muted"
          aria-label="خروج"
          title="تسجيل الخروج"
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
            {(Object.keys(FOLDER_META) as MailFolder[]).map((f) => {
              const meta = FOLDER_META[f];
              const active = f === folder;
              const Icon = meta.icon;
              const { unread } = counts[f] || { unread: 0 };
              return (
                <button
                  key={f}
                  onClick={() => {
                    setFolder(f);
                    setSelectedId(null);
                    setSelectedMessage(null);
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
            selectedMessage ? "hidden md:flex" : "flex"
          }`}
        >
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4 text-xs">
            <span className="font-semibold text-muted-foreground">
              {FOLDER_META[folder].label} · {filteredMessages.length}
            </span>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && filteredMessages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MailIcon className="h-10 w-10 opacity-30" />
                <p className="text-sm">لا توجد رسائل هنا</p>
              </div>
            ) : (
              filteredMessages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  active={m.id === selectedId}
                  onClick={() => openMessage(m.id)}
                  onToggleStar={(e) => toggleStar(e, m.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Message viewer */}
        <div
          className={`flex-1 overflow-hidden bg-surface ${
            selectedMessage ? "flex" : "hidden md:flex"
          } flex-col`}
        >
          {selectedMessage ? (
            <MessageView
              message={selectedMessage}
              loading={reading}
              onBack={() => {
                setSelectedId(null);
                setSelectedMessage(null);
              }}
              onReply={() => setComposeOpen(true)}
              onArchive={() => handleMove(selectedMessage.id, "archive")}
              onDelete={() => handleDelete(selectedMessage.id)}
              onSpam={() => handleMove(selectedMessage.id, "spam")}
            />
          ) : (
            <EmptyViewer />
          )}
        </div>
      </div>

      {composeOpen && <Composer session={session} onClose={() => setComposeOpen(false)} onSent={refresh} />}
    </div>
  );
}

function MessageRow({
  message,
  active,
  onClick,
  onToggleStar,
}: {
  message: MailMessage;
  active: boolean;
  onClick: () => void;
  onToggleStar: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-right transition hover:bg-muted/50 ${
        active ? "bg-accent" : ""
      } ${!message.read ? "bg-card" : "bg-card/70"}`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
        {message.from.name.charAt(0) || message.from.email.charAt(0)}
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="mb-0.5 flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${
              !message.read ? "font-bold text-foreground" : "font-medium text-foreground/80"
            }`}
          >
            {message.from.name || message.from.email}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{formatDate(message.date)}</span>
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
          <button
            onClick={onToggleStar}
            className={`rounded p-0.5 hover:bg-muted ${message.starred ? "text-star" : "text-muted-foreground"}`}
            title={message.starred ? "إزالة المميّز" : "تمييز"}
          >
            <Star className={`h-3.5 w-3.5 ${message.starred ? "fill-star" : ""}`} />
          </button>
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
  loading,
  onBack,
  onReply,
  onArchive,
  onDelete,
  onSpam,
}: {
  message: MailMessage;
  loading: boolean;
  onBack: () => void;
  onReply: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSpam: () => void;
}) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
        >
          <ChevronLeft className="h-4 w-4" /> رجوع
        </button>
        <div className="hidden gap-1 md:flex">
          <button onClick={onArchive} className="rounded-lg p-2 hover:bg-muted" title="أرشفة">
            <Archive className="h-4 w-4" />
          </button>
          <button onClick={onDelete} className="rounded-lg p-2 hover:bg-muted" title="حذف">
            <Trash2 className="h-4 w-4" />
          </button>
          <button onClick={onSpam} className="rounded-lg p-2 hover:bg-muted" title="مزعج">
            <AlertOctagon className="h-4 w-4" />
          </button>
        </div>
        <button className="rounded-lg p-2 hover:bg-muted">
          <MoreVertical className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl p-4 sm:p-6">
            <h1 className="text-xl font-bold sm:text-2xl">{message.subject}</h1>
            <div className="mt-4 flex items-start gap-3 border-b border-border pb-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
                {message.from.name.charAt(0) || message.from.email.charAt(0)}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="font-semibold">{message.from.name || message.from.email}</span>
                    <span className="mr-2 text-xs text-muted-foreground" dir="ltr">
                      &lt;{message.from.email}&gt;
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDate(message.date)}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  إليّ · {message.to.map((t) => t.email).join(", ")}
                </p>
              </div>
            </div>

            <article
              className="prose prose-sm mt-6 max-w-none text-foreground"
              dangerouslySetInnerHTML={{ __html: message.body || message.preview }}
            />

            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-6">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">
                  المرفقات ({message.attachments.length})
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {message.attachments.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-gradient/10 text-brand-accent">
                        <Paperclip className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{a.filename}</p>
                        <p className="text-xs text-muted-foreground">{formatSize(a.size)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 flex gap-2">
              <button
                onClick={onReply}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Pencil className="h-4 w-4" /> رد
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function EmptyViewer() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
      <MailIcon className="h-16 w-16 opacity-30" />
      <p className="text-sm">اختر رسالة من القائمة لعرضها</p>
    </div>
  );
}

function Composer({
  session,
  onClose,
  onSent,
}: {
  session: MailSession;
  onClose: () => void;
  onSent: () => void;
}) {
  const send = useServerFn(bridgeSend);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!to || !subject) return;
    setSending(true);
    try {
      const parseAddresses = (raw: string) =>
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((email) => ({ name: "", email }));

      await send({
        data: {
          account: session.account,
          password: session.password,
          to: parseAddresses(to),
          cc: parseAddresses(cc),
          subject,
          bodyHtml: body,
          bodyText: body,
        },
      });
      toast.success("تم إرسال الرسالة");
      onClose();
      onSent();
    } catch (err: any) {
      toast.error(err?.message || "فشل إرسال الرسالة");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-2xl rounded-t-2xl border border-border bg-card shadow-float sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[560px]">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <p className="text-sm font-semibold">رسالة جديدة</p>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-4">
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="إلى"
          dir="ltr"
          className="w-full border-b border-border bg-transparent px-1 py-2 text-sm outline-none"
        />
        <input
          value={cc}
          onChange={(e) => setCc(e.target.value)}
          placeholder="Cc"
          dir="ltr"
          className="w-full border-b border-border bg-transparent px-1 py-2 text-sm outline-none"
        />
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="الموضوع"
          className="w-full border-b border-border bg-transparent px-1 py-2 text-sm outline-none"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          placeholder="اكتب رسالتك هنا..."
          className="w-full resize-none bg-transparent px-1 py-2 text-sm outline-none"
        />
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
        <button
          onClick={handleSend}
          disabled={sending || !to || !subject}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          إرسال
        </button>
        <button className="rounded-md p-2 hover:bg-muted">
          <Paperclip className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
