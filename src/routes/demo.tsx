import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Virtuoso } from "react-virtuoso";
import DOMPurify from "dompurify";
import { toast } from "sonner";
import {
  AlertOctagon,
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Check,
  CheckSquare,
  ChevronDown,
  Copy,
  FileText,
  Forward,
  Globe,
  Inbox,
  Loader2,
  LogOut,
  Mail as MailIcon,
  MailOpen,
  Menu,
  MinusSquare,
  MoreVertical,
  Paperclip,
  Pencil,
  Printer,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  Star,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { tr, trf, getCurrentLang } from "@/i18n";
import { useLanguage } from "@/hooks/use-language";
import { BrandLogo } from "@/components/brand-logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { DemoMailboxSwitcher } from "@/components/demo-mailbox-switcher";

import { ChevronBackward } from "@/components/ui/directional-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getMessages, getFolderCounts, formatDate, formatSize } from "@/lib/mail-mock";
import type { MailFolder, MailMessage } from "@/lib/mail-types";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "تجربة الواجهة | MailMaestro" },
      {
        name: "description",
        content:
          "جرّب واجهة MailMaestro مباشرة ببيانات تجريبية — نسخة طبق الأصل من لوحة البريد بدون تسجيل دخول.",
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
  ssr: false,
  component: DemoMailApp,
});

// Same folder metadata as the real mailbox.
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

const VISIBLE_FOLDERS: MailFolder[] = [
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
];

type SortOption = "date-desc" | "date-asc" | "unread-first" | "starred-first";

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function demoToast() {
  toast.info(tr("هذه معاينة تجريبية — الإجراء الحقيقي يتم بعد ربط بريدك."));
}

function DemoMailApp() {
  const { lang, dir: uiDir } = useLanguage();
  const [messages, setMessages] = useState<MailMessage[]>(() => getMessages("all", lang));
  const [origins, setOrigins] = useState<Record<string, MailFolder>>({});
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"quick" | "deep">("quick");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const [sort, setSort] = useState<SortOption>("date-desc");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [composing, setComposing] = useState(false);
  const overridesRef = useRef<Map<string, Partial<MailMessage>>>(new Map());

  // Language switch → swap the whole dataset (AR ⇄ EN) but keep local edits.
  useEffect(() => {
    const fresh = getMessages("all", lang);
    setMessages(
      fresh.map((m) => {
        const o = overridesRef.current.get(m.id);
        return o ? ({ ...m, ...o } as MailMessage) : m;
      }),
    );
  }, [lang]);

  const patch = useCallback((id: string, next: Partial<MailMessage>) => {
    const prev = overridesRef.current.get(id) || {};
    overridesRef.current.set(id, { ...prev, ...next });
    setMessages((list) => list.map((m) => (m.id === id ? ({ ...m, ...next } as MailMessage) : m)));
  }, []);

  const counts = useMemo(() => {
    const base = getFolderCounts(lang);
    const map: Record<string, { total: number; unread: number; supported: boolean }> = {};
    base.forEach((c) => {
      const items = messages.filter((m) =>
        c.folder === "starred" ? m.starred : m.folder === c.folder,
      );
      map[c.folder] = {
        total: items.length,
        unread: items.filter((m) => !m.read).length,
        supported: true,
      };
    });
    return map;
  }, [messages, lang]);

  const filteredMessages = useMemo(() => {
    let list = messages.filter((m) => (folder === "starred" ? m.starred : m.folder === folder));
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.from.name.toLowerCase().includes(q) ||
          m.from.email.toLowerCase().includes(q) ||
          m.preview.toLowerCase().includes(q) ||
          (searchMode === "deep" && m.body.toLowerCase().includes(q)),
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (sort === "date-asc") sorted.reverse();
    if (sort === "unread-first") sorted.sort((a, b) => Number(a.read) - Number(b.read));
    if (sort === "starred-first") sorted.sort((a, b) => Number(b.starred) - Number(a.starred));
    return sorted;
  }, [messages, folder, query, sort, searchMode]);

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedId) ?? null,
    [messages, selectedId],
  );

  const inDeepSearch = searchMode === "deep" && query.trim().length > 0;

  function refresh() {
    setRefreshing(true);
    window.setTimeout(() => setRefreshing(false), 700);
  }

  function openMessage(id: string) {
    setSelectedId(id);
    patch(id, { read: true });
  }

  function closeMessage() {
    setSelectedId(null);
  }

  function move(id: string, dest: MailFolder) {
    const current = messages.find((m) => m.id === id);
    if (current) setOrigins((o) => ({ ...o, [id]: current.folder }));
    patch(id, { folder: dest });
    setSelectedId((s) => (s === id ? null : s));
    toast.success(dest === "trash" ? tr("تم النقل إلى المهملات") : tr("تم النقل"));
  }

  function restore(id: string) {
    const dest = origins[id] ?? "inbox";
    patch(id, { folder: dest });
    setSelectedId((s) => (s === id ? null : s));
    toast.success(tr("تمت الاستعادة"));
  }

  function removeForever(id: string) {
    overridesRef.current.delete(id);
    setMessages((list) => list.filter((m) => m.id !== id));
    setSelectedId((s) => (s === id ? null : s));
    toast.success(tr("تم الحذف نهائياً"));
  }

  function toggleSelect(id: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelection((prev) =>
      prev.size >= filteredMessages.length && filteredMessages.length > 0
        ? new Set()
        : new Set(filteredMessages.map((m) => m.id)),
    );
  }

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setSelection(new Set());
  }

  function bulk(fn: (id: string) => void, label: string) {
    selection.forEach(fn);
    setSelection(new Set());
    setSelectMode(false);
    toast.success(label);
  }

  return (
    <div className="flex h-screen w-full flex-col bg-background">
      {/* Demo banner */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-brand-gradient px-3 py-2 text-xs font-medium text-white">
        <span>{tr("وضع تجريبي — بيانات وهمية، بدون أي اتصال بحساب بريد حقيقي.")}</span>
        <Link to="/login" className="underline underline-offset-2 hover:opacity-90">
          {tr("ابدأ ببريدك الحقيقي")}
        </Link>
      </div>

      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4">
        <button
          onClick={() => setSidebarOpen((s) => !s)}
          className="rounded-lg p-2 hover:bg-muted lg:hidden"
          aria-label={tr("القائمة")}
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link to="/" className="flex shrink-0 items-center gap-1.5" dir="ltr">
          <BrandLogo className="h-8 w-8 rounded-lg" />
          <span className="hidden text-base font-bold sm:inline">MailMaestro</span>
        </Link>

        <div
          className="mx-2 flex flex-1 items-center gap-1 rounded-xl bg-muted/70 pe-1 ps-3 py-1.5 transition focus-within:bg-card focus-within:shadow-elevated sm:mx-4 sm:max-w-xl"
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        >
          {searchMode === "deep" ? (
            <Globe className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              searchMode === "deep" ? tr("بحث شامل على السيرفر…") : tr("ابحث في البريد...")
            }
            className="w-full bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={tr("مسح")}
              aria-label={tr("مسح")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <DropdownMenu dir={uiDir} onOpenChange={setSearchDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                  searchMode === "deep"
                    ? "bg-primary/10 text-primary hover:bg-primary/15"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                title={tr("خيارات البحث")}
              >
                {searchMode === "deep" ? (
                  <Globe className="h-3.5 w-3.5" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">
                  {searchMode === "deep" ? tr("شامل") : tr("سريع")}
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
                {tr("نمط البحث")}
              </div>
              <DropdownMenuItem
                onSelect={() => setSearchMode("quick")}
                className="flex items-start gap-2 cursor-pointer"
              >
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{tr("بحث سريع")}</span>
                    {searchMode === "quick" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tr("فوري في الرسائل المعروضة — دون أي طلب للسيرفر")}
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setSearchMode("deep")}
                className="flex items-start gap-2 cursor-pointer"
              >
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{tr("بحث شامل على السيرفر")}</span>
                    {searchMode === "deep" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {tr("IMAP SEARCH على كامل المجلد الحالي (الموضوع + المرسل + المستلمين)")}
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <div
            className={`flex items-center gap-0.5 overflow-hidden transition-all duration-300 ease-out lg:hidden ${
              searchFocused || searchDropdownOpen ? "max-w-0 opacity-0" : "max-w-[6rem] opacity-100"
            }`}
          >
            <button
              onClick={refresh}
              disabled={refreshing}
              className="shrink-0 rounded-lg p-2 hover:bg-muted disabled:opacity-70"
              aria-label={tr("تحديث")}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
            </button>
            <DemoMailboxSwitcher compact />
          </div>

          <div className="hidden lg:block">
            <DemoMailboxSwitcher />
          </div>


          <button
            onClick={refresh}
            disabled={refreshing}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-70 lg:inline-flex"
            title={tr("تحديث البريد")}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
            <span className="hidden lg:inline">
              {refreshing ? tr("جاري التحديث...") : tr("تحديث")}
            </span>
          </button>
          <div className="hidden lg:block">
            <LanguageSwitcher />
          </div>
          <Link
            to="/"
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive lg:inline-flex"
            title={tr("خروج")}
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden lg:inline">{tr("خروج")}</span>
          </Link>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 start-0 top-14 z-30 flex w-64 shrink-0 transform flex-col border-e border-border bg-sidebar transition-transform lg:relative lg:top-0 lg:translate-x-0 ${
            sidebarOpen
              ? "translate-x-0"
              : `${uiDir === "rtl" ? "translate-x-full" : "-translate-x-full"} lg:translate-x-0`
          }`}
        >
          <div className="p-4">
            <button
              onClick={() => {
                setComposing(true);
                setSelectedId(null);
                setSidebarOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-2xl bg-brand-gradient px-5 py-3.5 text-sm font-semibold text-white shadow-brand transition hover:scale-[1.02]"
            >
              <Pencil className="h-4 w-4" />
              {tr("رسالة جديدة")}
            </button>
          </div>

          <nav className="px-2">
            {VISIBLE_FOLDERS.map((f) => {
              const meta = FOLDER_META[f];
              const active = f === folder;
              const Icon = meta.icon;
              const total = counts[f]?.total ?? 0;
              return (
                <button
                  key={f}
                  onClick={() => {
                    setFolder(f);
                    setSelectedId(null);
                    setComposing(false);
                    setSelection(new Set());
                    setSidebarOpen(false);
                  }}
                  className={`mb-0.5 flex w-full items-center gap-3 rounded-e-full rounded-s-md px-4 py-2.5 text-sm transition ${
                    active
                      ? "bg-sidebar-hover font-semibold text-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-hover/60"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${active ? "text-primary" : ""}`} />
                  <span className="flex-1 text-start">{tr(meta.label)}</span>
                  {total > 0 && (
                    <span
                      className={`rounded-full px-1.5 text-[11px] font-bold ${
                        active ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {total}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto border-t border-border p-3 lg:hidden">
            <div className="flex items-center justify-between gap-2">
              <LanguageSwitcher />
              <Link
                to="/"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
              >
                <LogOut className="h-4 w-4" />
                <span>{tr("خروج")}</span>
              </Link>
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
          className={`flex w-full flex-col border-e border-border bg-card md:w-96 md:shrink-0 ${
            composing || selectedMessage ? "hidden md:flex" : "flex"
          }`}
        >
          {selectMode || selection.size > 0 ? (
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-accent/40 px-4 text-xs">
              <button
                onClick={toggleSelectAllVisible}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted"
                title={tr("تحديد الكل")}
              >
                {selection.size >= filteredMessages.length && filteredMessages.length > 0 ? (
                  <CheckSquare className="h-5 w-5 text-primary" />
                ) : selection.size > 0 ? (
                  <MinusSquare className="h-5 w-5 text-primary" />
                ) : (
                  <Square className="h-5 w-5 text-muted-foreground" />
                )}
              </button>
              <span className="font-semibold text-foreground">
                {selection.size > 0
                  ? trf("الرسائل المحددة", { count: selection.size })
                  : tr("اختر الرسائل")}
              </span>
              <div className="flex-1" />
              {selection.size > 0 && (
                <DropdownMenu dir={uiDir}>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
                      title={tr("إجراءات")}
                    >
                      <MoreVertical className="h-4 w-4" />
                      <span>{tr("إجراءات")}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    {(folder === "trash" || folder === "archive") && (
                      <>
                        <DropdownMenuItem
                          onClick={() => bulk((id) => restore(id), tr("تمت الاستعادة"))}
                        >
                          <ArchiveRestore className="ms-2 h-4 w-4" />
                          {tr("استعادة المحدد")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      onClick={() => bulk((id) => move(id, "archive"), tr("تم النقل"))}
                    >
                      <Archive className="ms-2 h-4 w-4" />
                      {tr("أرشفة المحدد")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => bulk((id) => move(id, "spam"), tr("تم النقل"))}
                    >
                      <AlertOctagon className="ms-2 h-4 w-4" />
                      {tr("نقل إلى المزعج")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() =>
                        bulk((id) => patch(id, { read: false }), tr("تم تعليم الرسائل"))
                      }
                    >
                      <MailIcon className="ms-2 h-4 w-4" />
                      {tr("تعليم كغير مقروءة")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() =>
                        bulk(
                          (id) => (folder === "trash" ? removeForever(id) : move(id, "trash")),
                          tr("تم الحذف"),
                        )
                      }
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="ms-2 h-4 w-4" />
                      {folder === "trash" ? tr("حذف نهائياً") : tr("نقل إلى المهملات")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button
                onClick={toggleSelectMode}
                className="rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                {tr("إلغاء")}
              </button>
            </div>
          ) : (
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4 text-xs">
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleSelectMode}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted"
                  title={tr("تحديد")}
                >
                  <Square className="h-5 w-5 text-muted-foreground" />
                </button>
                <span className="font-semibold text-muted-foreground">
                  {inDeepSearch ? (
                    <span className="flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5 text-primary" />
                      <span>
                        {tr("نتائج السيرفر")} · {filteredMessages.length}
                      </span>
                    </span>
                  ) : (
                    <>
                      {tr("المعروضة")} · {filteredMessages.length}
                    </>
                  )}
                </span>
              </div>
              <DropdownMenu dir={uiDir}>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                    title={tr("ترتيب العرض")}
                  >
                    <ArrowUpDown className="h-3.5 w-3.5" />
                    <span>{tr("ترتيب")}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {(
                    [
                      { value: "date-desc", label: tr("الأحدث أولاً") },
                      { value: "date-asc", label: tr("الأقدم أولاً") },
                      { value: "unread-first", label: tr("غير المقروءة أولاً") },
                      { value: "starred-first", label: tr("المميّزة بنجمة أولاً") },
                    ] as { value: SortOption; label: string }[]
                  ).map((opt, i) => (
                    <div key={opt.value}>
                      {i > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        onClick={() => setSort(opt.value)}
                        className="flex items-center justify-between gap-2"
                      >
                        <span>{opt.label}</span>
                        {sort === opt.value && <Check className="h-4 w-4 text-primary" />}
                      </DropdownMenuItem>
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            {filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MailIcon className="h-10 w-10 opacity-30" />
                <p className="text-sm">{tr("لا توجد رسائل هنا")}</p>
              </div>
            ) : (
              <Virtuoso
                style={{ height: "100%" }}
                data={filteredMessages}
                overscan={800}
                computeItemKey={(_, m) => m.id}
                itemContent={(_, m) => (
                  <MessageRow
                    message={m}
                    active={m.id === selectedId}
                    selected={selection.has(m.id)}
                    selectMode={selectMode}
                    onClick={() => (selectMode ? toggleSelect(m.id) : openMessage(m.id))}
                    onToggleStar={() => patch(m.id, { starred: !m.starred })}
                    onToggleRead={() => patch(m.id, { read: !m.read })}
                    onToggleSelect={() => toggleSelect(m.id)}
                  />
                )}
                components={{
                  Footer: () => (
                    <div className="py-4 text-center text-[11px] text-muted-foreground">
                      {tr("— نهاية الرسائل —")}
                    </div>
                  ),
                }}
              />
            )}
          </div>
        </div>

        {/* Viewer */}
        <div
          className={`flex-1 overflow-hidden bg-white ${
            composing || selectedMessage ? "flex" : "hidden md:flex"
          } flex-col`}
        >
          {composing ? (
            <DemoComposer onClose={() => setComposing(false)} />
          ) : selectedMessage ? (
            <MessageView
              message={selectedMessage}
              onBack={closeMessage}
              onReply={demoToast}
              onReplyAll={demoToast}
              onForward={demoToast}
              onArchive={() => move(selectedMessage.id, "archive")}
              onSpam={() => move(selectedMessage.id, "spam")}
              onRestore={() => restore(selectedMessage.id)}
              onMarkUnread={() => {
                patch(selectedMessage.id, { read: false });
                closeMessage();
              }}
              onDelete={() =>
                selectedMessage.folder === "trash"
                  ? removeForever(selectedMessage.id)
                  : move(selectedMessage.id, "trash")
              }
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <MailIcon className="h-16 w-16 opacity-30" />
              <p className="text-sm">{tr("اختر رسالة من القائمة لعرضها")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  active,
  selected,
  selectMode,
  onClick,
  onToggleStar,
  onToggleRead,
  onToggleSelect,
}: {
  message: MailMessage;
  active: boolean;
  selected: boolean;
  selectMode: boolean;
  onClick: () => void;
  onToggleStar: () => void;
  onToggleRead: () => void;
  onToggleSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group flex w-full cursor-pointer items-start gap-3 border-b border-border/60 px-4 py-3 text-start transition-colors duration-150 hover:bg-muted/50 active:bg-muted ${
        active ? "bg-accent" : ""
      } ${selected ? "bg-primary/5" : ""} ${!message.read ? "bg-card" : "bg-card/70"}`}
    >
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white transition ${
            selectMode || selected ? "opacity-0" : "opacity-100"
          }`}
        >
          {(message.from.name || message.from.email).charAt(0).toUpperCase()}
        </div>
        <div
          role="checkbox"
          aria-checked={selected}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onToggleSelect();
            }
          }}
          className={`absolute inset-0 z-10 flex items-center justify-center rounded-full transition ${
            selectMode || selected ? "opacity-100" : "opacity-0"
          }`}
          title={selected ? tr("إلغاء التحديد") : tr("تحديد")}
        >
          {selected ? (
            <CheckSquare className="h-5 w-5 text-primary" />
          ) : (
            <Square className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
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
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatDate(message.date, getCurrentLang())}
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
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar();
            }}
            className={`rounded p-0.5 hover:bg-muted ${message.starred ? "text-star" : "text-muted-foreground"}`}
            title={message.starred ? tr("إزالة المميّز") : tr("تمييز")}
          >
            <Star className={`h-3.5 w-3.5 ${message.starred ? "fill-star" : ""}`} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleRead();
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={message.read ? tr("تعليم كغير مقروءة") : tr("تعليم كمقروءة")}
          >
            {message.read ? (
              <MailIcon className="h-3.5 w-3.5" />
            ) : (
              <MailOpen className="h-3.5 w-3.5" />
            )}
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
    </div>
  );
}

function MessageView({
  message,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
  onSpam,
  onMarkUnread,
  onRestore,
}: {
  message: MailMessage;
  onBack: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSpam: () => void;
  onMarkUnread: () => void;
  onRestore: () => void;
}) {
  const { dir: uiDir, lang } = useLanguage();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const recipientsAll = [...message.to, ...(message.cc || [])];
  const toSummary =
    recipientsAll.length > 0 ? recipientsAll.map((r) => r.email).join(tr("،")) : "—";
  const fullDate = new Date(message.date).toLocaleString(lang === "ar" ? "ar-SA" : "en-GB", {
    dateStyle: "full",
    timeStyle: "short",
  });
  const isTrash = message.folder === "trash";
  const canRestore = message.folder === "trash" || message.folder === "archive";
  const canArchive = message.folder !== "archive" && message.folder !== "trash";

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(message.from.email);
      toast.success(tr("تم نسخ البريد"));
    } catch {
      toast.error(tr("تعذّر النسخ"));
    }
  }

  function printMessage() {
    window.print();
  }

  return (
    <>
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
          aria-label={tr("رجوع")}
        >
          <ChevronBackward className="h-4 w-4" /> {tr("رجوع")}
        </button>
        <div className="hidden gap-1 md:flex">
          <button onClick={onReply} className="rounded-lg p-2 hover:bg-muted" title={tr("رد")}>
            <Reply className="h-4 w-4" />
          </button>
          <button
            onClick={onReplyAll}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("رد على الكل")}
          >
            <ReplyAll className="h-4 w-4" />
          </button>
          <button
            onClick={onForward}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("إعادة توجيه")}
          >
            <Forward className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          {canRestore && (
            <button
              onClick={onRestore}
              className="rounded-lg p-2 hover:bg-muted"
              title={tr("استعادة إلى المجلد الأصلي")}
            >
              <ArchiveRestore className="h-4 w-4" />
            </button>
          )}
          {canArchive && (
            <button
              onClick={onArchive}
              className="rounded-lg p-2 hover:bg-muted"
              title={tr("أرشفة")}
            >
              <Archive className="h-4 w-4" />
            </button>
          )}
          <button onClick={onSpam} className="rounded-lg p-2 hover:bg-muted" title={tr("مزعج")}>
            <AlertOctagon className="h-4 w-4" />
          </button>
          <button
            onClick={onMarkUnread}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("تعليم كغير مقروءة")}
          >
            <MailOpen className="h-4 w-4" />
          </button>
          <button
            onClick={printMessage}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("طباعة")}
          >
            <Printer className="h-4 w-4" />
          </button>
          <button
            onClick={copyEmail}
            className="rounded-lg p-2 hover:bg-muted"
            title={tr("نسخ عنوان المرسل")}
          >
            <Copy className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          <button
            onClick={onDelete}
            className="rounded-lg p-2 text-destructive hover:bg-destructive/10"
            title={isTrash ? tr("حذف نهائي") : tr("نقل إلى المهملات")}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <DropdownMenu dir={uiDir}>
          <DropdownMenuTrigger asChild>
            <button className="rounded-lg p-2 hover:bg-muted" aria-label={tr("خيارات أكثر")}>
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} collisionPadding={12} className="w-56">
            <DropdownMenuItem onClick={onReply}>
              <Reply className="h-4 w-4" /> {tr("رد")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReplyAll}>
              <ReplyAll className="h-4 w-4" /> {tr("رد على الكل")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onForward}>
              <Forward className="h-4 w-4" /> {tr("إعادة توجيه")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onMarkUnread}>
              <MailOpen className="h-4 w-4" /> {tr("تعليم كغير مقروءة")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={printMessage}>
              <Printer className="h-4 w-4" /> {tr("طباعة")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyEmail}>
              <Copy className="h-4 w-4" /> {tr("نسخ عنوان المرسل")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {canRestore && (
              <DropdownMenuItem onClick={onRestore}>
                <ArchiveRestore className="h-4 w-4" /> {tr("استعادة إلى المجلد الأصلي")}
              </DropdownMenuItem>
            )}
            {canArchive && (
              <DropdownMenuItem onClick={onArchive} className="md:hidden">
                <Archive className="h-4 w-4" /> {tr("أرشفة")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onSpam} className="md:hidden">
              <AlertOctagon className="h-4 w-4" /> {tr("مزعج")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> {isTrash ? tr("حذف نهائي") : tr("نقل إلى المهملات")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          <h1 className="break-words text-xl font-bold leading-snug sm:text-2xl">
            {message.subject || tr("(بدون موضوع)")}
          </h1>

          <div className="mt-4 flex items-start gap-3 border-b border-border pb-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
              {(message.from.name || message.from.email || "?").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold leading-tight">
                    {message.from.name || message.from.email}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={message.from.email}
                  >
                    <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                      {message.from.email}
                    </span>
                  </div>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                  {formatDate(message.date, lang)}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-expanded={detailsOpen}
                  className="inline-flex max-w-full items-center gap-1 rounded hover:text-foreground"
                  title={tr("تفاصيل الرسالة")}
                >
                  <span className="truncate">
                    <span className="text-foreground/70">{tr("إلى")} </span>
                    <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                      {toSummary}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {detailsOpen && (
                  <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3">
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1.5 text-xs">
                      <dt className="whitespace-nowrap text-foreground/70">{tr("المرسل:")}</dt>
                      <dd className="min-w-0 break-all">
                        <span className="me-1">{message.from.name}</span>
                        <span dir="ltr" className="text-muted-foreground">
                          &lt;{message.from.email}&gt;
                        </span>
                      </dd>
                      <dt className="whitespace-nowrap text-foreground/70">{tr("المستلم:")}</dt>
                      <dd className="min-w-0 break-all">
                        <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                          {message.to.map((t) => t.email).join(", ")}
                        </span>
                      </dd>
                      {message.cc && message.cc.length > 0 && (
                        <>
                          <dt className="whitespace-nowrap text-foreground/70">{tr("نسخة:")}</dt>
                          <dd className="min-w-0 break-all">
                            <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                              {message.cc.map((c) => c.email).join(", ")}
                            </span>
                          </dd>
                        </>
                      )}
                      <dt className="whitespace-nowrap text-foreground/70">{tr("التاريخ:")}</dt>
                      <dd className="min-w-0">{fullDate}</dd>
                      {message.mailedBy && (
                        <>
                          <dt className="whitespace-nowrap text-foreground/70">{tr("الخادم:")}</dt>
                          <dd className="min-w-0 break-all">
                            <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                              {message.mailedBy}
                            </span>
                          </dd>
                        </>
                      )}
                      {message.signedBy && (
                        <>
                          <dt className="whitespace-nowrap text-foreground/70">{tr("التوقيع:")}</dt>
                          <dd className="min-w-0 break-all">
                            <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                              {message.signedBy}
                            </span>
                          </dd>
                        </>
                      )}
                      {message.security && (
                        <>
                          <dt className="whitespace-nowrap text-foreground/70">{tr("الأمان:")}</dt>
                          <dd className="inline-flex min-w-0 items-center gap-1">
                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                            <span>{message.security}</span>
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            dir={lang === "ar" ? "rtl" : "ltr"}
            className="prose prose-sm mt-6 max-w-none text-foreground [&_a]:text-primary"
            // Static demo content bundled with the app, sanitized as defense in depth.
            dangerouslySetInnerHTML={{ __html: sanitize(message.body) }}
          />

          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">
                {tr("المرفقات")} ({message.attachments.length})
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {message.attachments.map((a) => (
                  <button
                    key={a.id}
                    onClick={demoToast}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-start transition hover:bg-muted"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Paperclip className="h-4 w-4 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.filename}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {formatSize(a.size)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-2">
            <button
              onClick={onReply}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <Reply className="h-4 w-4" /> {tr("رد")}
            </button>
            <button
              onClick={onReplyAll}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <ReplyAll className="h-4 w-4" /> {tr("رد على الكل")}
            </button>
            <button
              onClick={onForward}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <Forward className="h-4 w-4" /> {tr("إعادة توجيه")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function DemoComposer({ onClose }: { onClose: () => void }) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-surface/80 px-3 py-2.5 backdrop-blur sm:px-6 sm:py-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-brand sm:h-9 sm:w-9">
            <Send className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {subject || tr("رسالة جديدة")}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">you@mailmaestro.app</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label={tr("إغلاق")}
          title={tr("إغلاق (Esc)")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full flex-col gap-3 px-3 py-4 sm:px-6 sm:py-5">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
            <span className="shrink-0 text-xs text-muted-foreground">{tr("المرسل له")}</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              dir="ltr"
              className="w-full bg-transparent text-sm outline-none"
              placeholder="name@example.com"
            />
            {!showCc && (
              <button
                onClick={() => setShowCc(true)}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-primary"
              >
                {tr("نسخة")}
              </button>
            )}
          </div>
          {showCc && (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
              <span className="shrink-0 text-xs text-muted-foreground">{tr("نسخة")}</span>
              <input
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                dir="ltr"
                className="w-full bg-transparent text-sm outline-none"
                placeholder="cc@example.com"
              />
            </div>
          )}
          <div className="rounded-xl border border-border bg-card px-3 py-2">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full bg-transparent text-sm outline-none"
              placeholder={tr("الموضوع")}
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full resize-none rounded-xl border border-border bg-card p-3 text-sm outline-none"
            placeholder={tr("اكتب رسالتك هنا…")}
          />
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-surface/80 px-3 py-2.5 backdrop-blur sm:px-6 sm:py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={demoToast}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-brand transition hover:opacity-95 sm:px-5 sm:py-2.5"
          >
            <Send className="h-4 w-4" />
            {tr("إرسال")}
          </button>
          <button
            onClick={demoToast}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground sm:px-3"
            title={tr("إرفاق ملف")}
          >
            <Paperclip className="h-4 w-4" />
            <span className="hidden sm:inline">{tr("إرفاق")}</span>
          </button>
        </div>
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
          {tr("تجاهل")}
        </button>
      </div>
    </div>
  );
}
