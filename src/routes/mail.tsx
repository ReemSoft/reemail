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
  ChevronDown,
  Reply,
  ReplyAll,
  Forward,
  Printer,
  MailOpen,
  Copy,
  ShieldCheck,
  ShieldAlert,
  CheckSquare,
  Square,
  MinusSquare,
  ArchiveRestore,
  Zap,
  Globe,
  Check,
  ArrowUpDown,
  Download,
  CircleArrowDown,
  Eye,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  FileCode,
  FileType,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useCompanyTheme } from "@/hooks/use-company-theme";
import {
  bridgeGetFolderCounts,
  bridgeGetMessages,
  bridgeGetMessage,
  bridgeMarkRead,
  bridgeStar,
  bridgeMove,
  bridgeDelete,
  bridgeSearch,
} from "@/lib/mail-bridge.functions";
import { indexListMessages } from "@/lib/mail-index.functions";
import { indexListFolderCounts } from "@/lib/mail-index-counts.functions";
import { indexUpdateFlag } from "@/lib/mail-flags.functions";
import { indexMoveMessage } from "@/lib/mail-move.functions";
import { indexDeleteMessage } from "@/lib/mail-delete.functions";
import { MAIL_INDEX_ENABLED } from "@/lib/mail-feature-flags";
import { useMailIndexSync } from "@/hooks/use-mail-index-sync";
import {
  applyOverrides as applyFlagOverrides,
  applyOverrideToOne as applyFlagOverrideToOne,
  applyHidden as applyHiddenIds,
  clearOverride as clearFlagOverride,
  clearOverrideField as clearFlagOverrideField,
  confirmHide,
  gcHiddenBefore,
  hideId,
  reconcileOverrides as reconcileFlagOverrides,
  setOverride as setFlagOverride,
  unhideId,
  type HiddenIdsSet,
  type OverridesMap as FlagOverridesMap,
} from "@/lib/mail-pending-overrides";

import { runManualRefresh } from "@/lib/mail-refresh-orchestration";
import { createSingleFlight } from "@/lib/single-flight";
import {
  formatDate,
  formatSize,
  getFolderCounts as getMockFolderCounts,
  getMessages as getMockMessages,
  getMessage as getMockMessage,
} from "@/lib/mail-mock";
import type { MailFolder, MailMessage } from "@/lib/mail-types";
import { clearMailSession, getMailSession, type MailSession } from "@/lib/mail-session";

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

// ---- Trash origin tracking (for restore-to-original-folder) ----
const TRASH_ORIGIN_KEY = "mailmaestro:trash-origin";
type OriginMap = Record<string, MailFolder>;
function loadOriginMap(): OriginMap {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(TRASH_ORIGIN_KEY) || "{}") as OriginMap;
  } catch {
    return {};
  }
}
function saveOriginMap(map: OriginMap) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(TRASH_ORIGIN_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota errors */
  }
}
function rememberOrigin(threadId: string | undefined, folder: MailFolder) {
  if (!threadId || folder === "trash") return;
  const m = loadOriginMap();
  m[threadId] = folder;
  saveOriginMap(m);
}
function getOrigin(threadId: string | undefined): MailFolder {
  if (!threadId) return "inbox";
  const m = loadOriginMap();
  return m[threadId] || "inbox";
}
function forgetOrigin(threadId: string | undefined) {
  if (!threadId) return;
  const m = loadOriginMap();
  if (threadId in m) {
    delete m[threadId];
    saveOriginMap(m);
  }
}

type ComposeInitial = {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
};

function stripHtml(html: string): string {
  if (!html) return "";
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "");
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function quoteBody(message: MailMessage): string {
  const src = stripHtml(message.body || message.preview || "");
  const dateStr = new Date(message.date).toLocaleString("ar", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const from = message.from.name
    ? `${message.from.name} <${message.from.email}>`
    : message.from.email;
  const header = `\n\n\nOn ${dateStr}, ${from} wrote:\n`;
  const quoted = src
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return header + quoted;
}

function buildReply(message: MailMessage, myEmail: string, all: boolean): ComposeInitial {
  const subject = message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`;
  const to = message.from.email;
  let cc = "";
  if (all) {
    const others = [
      ...message.to.map((a) => a.email),
      ...(message.cc?.map((a) => a.email) ?? []),
    ].filter(
      (e) => e && e.toLowerCase() !== myEmail.toLowerCase() && e.toLowerCase() !== to.toLowerCase(),
    );
    cc = Array.from(new Set(others)).join(", ");
  }
  return { to, cc, subject, body: quoteBody(message) };
}

function buildForward(message: MailMessage): ComposeInitial {
  const subject = message.subject.startsWith("Fwd:") ? message.subject : `Fwd: ${message.subject}`;
  const header =
    `\n\n---------- Forwarded message ----------\n` +
    `From: ${message.from.name} <${message.from.email}>\n` +
    `Date: ${new Date(message.date).toLocaleString("ar")}\n` +
    `Subject: ${message.subject}\n` +
    `To: ${message.to.map((t) => t.email).join(", ")}\n\n` +
    stripHtml(message.body || message.preview || "");
  return { to: "", subject, body: header };
}

type SortOption = "date-desc" | "date-asc" | "unread-first" | "starred-first";

type SourceKind = "index" | "bridge" | "mock";

function useMailData(session: MailSession | null) {
  const getCounts = useServerFn(bridgeGetFolderCounts);
  const getMessages = useServerFn(bridgeGetMessages);
  const listIndex = useServerFn(indexListMessages);
  const listIndexCounts = useServerFn(indexListFolderCounts);
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [sort, setSort] = useState<SortOption>("date-desc");
  const [counts, setCounts] = useState<
    Record<MailFolder, { total: number; unread: number; supported: boolean }>
  >({
    inbox: { total: 0, unread: 0, supported: true },
    starred: { total: 0, unread: 0, supported: true },
    sent: { total: 0, unread: 0, supported: true },
    drafts: { total: 0, unread: 0, supported: true },
    spam: { total: 0, unread: 0, supported: true },
    trash: { total: 0, unread: 0, supported: true },
    archive: { total: 0, unread: 0, supported: true },
    all: { total: 0, unread: 0, supported: true },
  });
  const [folderPaths, setFolderPaths] = useState<Partial<Record<MailFolder, string>>>({});
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [useMock, setUseMock] = useState(false);
  const [source, setSource] = useState<SourceKind>("bridge");
  const [indexCursor, setIndexCursor] = useState<string | null>(null);
  // Per-folder "index ready" flag, used to drive the sync hook.
  const [indexReady, setIndexReady] = useState<Partial<Record<MailFolder, boolean>>>({});
  // Race guard: only accept a load result whose id matches the latest request.
  const loadReqIdRef = useRef(0);
  const PAGE = 50;

  // Pending Flag Overrides — persist optimistic star/read across any
  // server-list arrival (Local Index, Bridge, background sync, pagination,
  // deep search). Entries are cleared on mutation failure (rollback) or
  // when a fresh server row confirms the expected value.
  const pendingOverridesRef = useRef<FlagOverridesMap>(new Map());
  // Optimistic hide set — rows removed by the user (unstar in the "starred"
  // folder) that must NOT be resurrected by a racing sync response.
  const pendingHiddenRef = useRef<HiddenIdsSet>(new Map());
  // V4: Starred-count race guard. `active` = in-flight star mutations;
  // `settledAt` = timestamp of the most recent resolution. While either
  // is "hot" (active > 0 OR within 2s of settledAt), counts loaders must
  // NOT overwrite `starred.total` — a stale server value would clobber
  // the optimistic delta applied by toggleStar.
  const pendingStarMutRef = useRef<{ active: number; settledAt: number }>({
    active: 0,
    settledAt: 0,
  });
  const STAR_COUNT_HOT_MS = 2000;
  const isStarCountHot = useCallback(() => {
    const s = pendingStarMutRef.current;
    return s.active > 0 || Date.now() - s.settledAt < STAR_COUNT_HOT_MS;
  }, []);

  /** Apply overrides + hidden filter to `list`, GC confirmed entries. */
  const applyPending = useCallback((list: MailMessage[]): MailMessage[] => {
    reconcileFlagOverrides(list, pendingOverridesRef.current);
    const patched = applyFlagOverrides(list, pendingOverridesRef.current);
    return applyHiddenIds(patched, pendingHiddenRef.current);
  }, []);

  /** Wrap a single incoming message the same way (used by messageCache). */
  const applyPendingOne = useCallback(
    (m: MailMessage): MailMessage => applyFlagOverrideToOne(m, pendingOverridesRef.current),
    [],
  );



  const folderPath = folderPaths[folder] ?? null;

  const loadCounts = useCallback(async () => {
    if (!session) return;
    try {
      const result = await getCounts({
        data: { account: session.account, password: session.password },
      });
      const map: Record<MailFolder, { total: number; unread: number; supported: boolean }> = {
        inbox: { total: 0, unread: 0, supported: true },
        starred: { total: 0, unread: 0, supported: true },
        sent: { total: 0, unread: 0, supported: true },
        drafts: { total: 0, unread: 0, supported: true },
        spam: { total: 0, unread: 0, supported: true },
        trash: { total: 0, unread: 0, supported: true },
        archive: { total: 0, unread: 0, supported: false },
        all: { total: 0, unread: 0, supported: false },
      };
      if (!result.ok) throw new Error(result.error);
      const paths: Partial<Record<MailFolder, string>> = {};
      result.counts.forEach((c) => {
        map[c.folder] = { total: c.total, unread: c.unread, supported: c.supported !== false };
        if (c.path) paths[c.folder] = c.path;
      });
      setCounts((prev) => {
        // V4 count race guard: while a star mutation is in flight (or was
        // very recently), keep the optimistic starred.total instead of the
        // possibly-stale server value.
        if (isStarCountHot() && prev.starred) {
          map.starred = { ...map.starred, total: prev.starred.total };
        }
        return map;
      });
      setFolderPaths(paths);
      setBridgeError(null);
    } catch (err: any) {
      setBridgeError(err?.message || "فشل الاتصال بخادم البريد");
      setCounts(
        Object.fromEntries(
          getMockFolderCounts().map((c) => [
            c.folder,
            { total: c.total, unread: c.unread, supported: true },
          ]),
        ) as Record<MailFolder, { total: number; unread: number; supported: boolean }>,
      );
    }
  }, [session, getCounts, isStarCountHot]);


  /**
   * Manual-Refresh counts path: prefer Local Mail Index (single Supabase
   * SELECT, no IMAP round-trip). Falls back to the bridge only when the
   * index has not yet resolved for this account/session. Also refreshes
   * `folderPaths` from any bridge fallback path — the index never invents
   * new paths.
   */
  const loadCountsFast = useCallback(async () => {
    if (!session) return;
    if (MAIL_INDEX_ENABLED && session.mailSessionToken) {
      try {
        const res = await listIndexCounts({
          data: { mailSessionToken: session.mailSessionToken },
        });
        if (res.ok && res.counts.length > 0) {
          setCounts((prev) => {
            const next = { ...prev };
            for (const c of res.counts) {
              if (!c.hasUidvalidity) continue;
              // V4 count race guard: skip starred.total while a mutation is
              // hot; keep the optimistic value the toggle already applied.
              if (c.folder === "starred" && isStarCountHot() && prev.starred) {
                const cur = next.starred ?? { total: 0, unread: 0, supported: true };
                next.starred = { total: prev.starred.total, unread: c.unread, supported: cur.supported };
                continue;
              }
              const cur = next[c.folder] ?? { total: 0, unread: 0, supported: true };
              next[c.folder] = { total: c.total, unread: c.unread, supported: cur.supported };
            }
            return next;
          });
          setFolderPaths((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const c of res.counts) {
              if (c.path && next[c.folder] !== c.path) {
                next[c.folder] = c.path;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          setBridgeError(null);
          return;
        }
      } catch {
        /* fall through to bridge */
      }
    }
    await loadCounts();
  }, [session, listIndexCounts, loadCounts, isStarCountHot]);

  // Decide whether this (folder, sort, session) call can use the Local Mail Index.
  // Only "date-desc" is index-native; other sorts fall back to the bridge.
  const canUseIndex = useCallback(
    (f: MailFolder, s: SortOption) =>
      MAIL_INDEX_ENABLED &&
      s === "date-desc" &&
      !!session?.mailSessionToken &&
      !!folderPaths[f] &&
      // V4: "starred" is a virtual view over INBOX (\Flagged). The Local
      // Index has no distinct row for it, so serving it from the index
      // would either return zero rows or (worse) return every inbox row
      // regardless of the \Flagged flag. Always fall through to the Bridge.
      f !== "starred",
    [session, folderPaths],
  );

  const loadFromBridge = useCallback(
    async (reqId: number) => {
      if (!session) return;
      try {
        const result = await getMessages({
          data: {
            account: session.account,
            password: session.password,
            folder,
            limit: PAGE,
            offset: 0,
            sort,
          },
        });
        if (loadReqIdRef.current !== reqId) return;
        if (!result.ok) throw new Error(result.error);
        setMessages(applyPending(result.messages));
        setHasMore(result.messages.length >= PAGE);
        setBridgeError(null);
        setUseMock(false);
        setSource("bridge");
        setIndexCursor(null);
      } catch (err: any) {
        if (loadReqIdRef.current !== reqId) return;
        setBridgeError(err?.message || "فشل جلب الرسائل");
        setMessages(applyPending(getMockMessages(folder)));
        setHasMore(false);
        setUseMock(true);
        setSource("mock");
        setIndexCursor(null);
      }
    },
    [session, folder, sort, getMessages, applyPending],
  );

  const loadMessages = useCallback(async () => {
    if (!session) return;
    const reqId = ++loadReqIdRef.current;
    // Timestamp captured BEFORE the request is issued. After the load
    // succeeds we drop every "confirmed" hide whose confirmedAt <= this
    // value: any mutation that confirmed before this load started is
    // guaranteed to be reflected in the response.
    const startedAt = Date.now();
    setLoading(true);
    try {
      if (canUseIndex(folder, sort)) {
        try {
          const res = await listIndex({
            data: {
              mailSessionToken: session.mailSessionToken!,
              canonical: folder,
              limit: PAGE,
            },
          });
          if (loadReqIdRef.current !== reqId) return;
          if (res.ok && res.indexed) {
            setMessages(applyPending(res.messages));
            setHasMore(res.hasMore);
            setIndexCursor(res.nextCursor);
            setSource("index");
            setUseMock(false);
            setBridgeError(null);
            setIndexReady((prev) => (prev[folder] ? prev : { ...prev, [folder]: true }));
            gcHiddenBefore(pendingHiddenRef.current, startedAt);
            return;
          }
          // Not indexed yet OR transient error → mark not-ready and fall back.
          setIndexReady((prev) => (prev[folder] === false ? prev : { ...prev, [folder]: false }));
        } catch {
          setIndexReady((prev) => (prev[folder] === false ? prev : { ...prev, [folder]: false }));
        }
      }
      await loadFromBridge(reqId);
      if (loadReqIdRef.current === reqId) {
        gcHiddenBefore(pendingHiddenRef.current, startedAt);
      }
    } finally {
      if (loadReqIdRef.current === reqId) setLoading(false);
    }
  }, [session, folder, sort, canUseIndex, listIndex, loadFromBridge, applyPending]);


  const loadMore = useCallback(async () => {
    if (!session || loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    try {
      if (source === "index" && indexCursor && canUseIndex(folder, sort)) {
        const res = await listIndex({
          data: {
            mailSessionToken: session.mailSessionToken!,
            canonical: folder,
            limit: PAGE,
            cursor: indexCursor,
          },
        });
        if (res.ok && res.indexed) {
          const patched = applyPending(res.messages);
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const merged = [...prev];
            for (const m of patched) if (!seen.has(m.id)) merged.push(m);
            return merged;
          });
          setHasMore(res.hasMore);
          setIndexCursor(res.nextCursor);
          return;
        }
        // Index no longer usable — stop paginating gracefully.
        setHasMore(false);
        return;
      }
      // Bridge pagination (offset-based).
      const offset = messages.length;
      const result = await getMessages({
        data: {
          account: session.account,
          password: session.password,
          folder,
          limit: PAGE,
          offset,
          sort,
        },
      });
      if (!result.ok) throw new Error(result.error);
      const patched = applyPending(result.messages);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const merged = [...prev];
        for (const m of patched) if (!seen.has(m.id)) merged.push(m);
        return merged;
      });
      setHasMore(result.messages.length >= PAGE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [
    session,
    folder,
    sort,
    getMessages,
    listIndex,
    messages.length,
    loadingMore,
    loading,
    hasMore,
    source,
    indexCursor,
    canUseIndex,
  ]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Reset to default sort whenever the folder changes (no persistence between refreshes).
  useEffect(() => {
    setSort("date-desc");
  }, [folder]);

  // Background Local Mail Index sync — initial when not ready, incremental
  // afterwards, plus a 5-minute reconcile once the folder is indexed.
  // Pauses when the tab is hidden and never overlaps itself.
  const isFolderIndexed = indexReady[folder] === true;
  const { reconcileNow, incrementalNow, shouldReconcile } = useMailIndexSync({
    session,
    folderPath,
    canonical: folder,
    indexed: isFolderIndexed,
    enabled:
      MAIL_INDEX_ENABLED &&
      !!session?.mailSessionToken &&
      sort === "date-desc" &&
      // "starred" is a virtual view over INBOX (see mail-index.functions.ts):
      // its canonical name collides with inbox on the (account_id, path)
      // uniqueness of mail_folders, so a starred sync round would just
      // overwrite the inbox folder row with duplicate work and never serve
      // starred correctly. Bridge listing owns starred; do not sync it here.
      folder !== "starred",
    onSynced: () => {
      // Background rounds only: refresh the current folder from the index
      // when the sync actually changed something (the hook already gates on
      // meaningful-change; suppressed rounds do NOT reach this callback).
      loadMessages();
      loadCountsFast();
    },
  });


  return {
    folder,
    setFolder,
    sort,
    setSort,
    counts,
    setCounts,
    messages,
    setMessages,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    bridgeError,
    useMock,
    loadCounts,
    source,
    /**
     * Manual Refresh contract (locked by tests):
     *   incrementalNow=1, list=1, counts=1 (via loadCountsFast → Local Index),
     *   reconcileNow is NEVER awaited on the manual path. When it's due,
     *   scheduleBackground fires it after the spinner has already ended.
     */
    refresh: () =>
      runManualRefresh({
        incrementalNow,
        reconcileNow,
        shouldReconcile,
        loadMessages,
        loadCounts: loadCountsFast,
      }),
    onAfterSend: async () => {
      // After a successful send: only refresh the Sent folder itself, and
      // only if the user is currently viewing it. From any other folder we
      // just pull counts once (Sent count moves; Inbox does not).
      if (folder === "sent") {
        await incrementalNow({ suppressOnSynced: true });
        await Promise.all([loadMessages(), loadCountsFast()]);
      } else {
        await loadCountsFast();
      }
    },
    // Pending Flag Overrides — exposed so MailApp toggleStar/toggleRead can
    // record the expected value BEFORE the mutation resolves. All server-
    // list writers inside useMailData already patch through applyPending.
    pendingOverridesRef,
    setPendingFlagOverride: (id: string, patch: { starred?: boolean; read?: boolean }) => {
      setFlagOverride(pendingOverridesRef.current, id, patch);
    },
    clearPendingFlagOverride: (id: string, field?: "starred" | "read") => {
      if (field) clearFlagOverrideField(pendingOverridesRef.current, id, field);
      else clearFlagOverride(pendingOverridesRef.current, id);
    },
    hideRow: (id: string) => hideId(pendingHiddenRef.current, id),
    unhideRow: (id: string) => unhideId(pendingHiddenRef.current, id),
    confirmHideRow: (id: string, at: number = Date.now()) =>
      confirmHide(pendingHiddenRef.current, id, at),
    // V4: star-mutation lifecycle hooks used by toggleStar to hold the
    // Starred count against racing loaders.
    beginStarMutation: () => {
      pendingStarMutRef.current.active++;
    },
    endStarMutation: () => {
      const s = pendingStarMutRef.current;
      if (s.active > 0) s.active--;
      s.settledAt = Date.now();
    },

    applyPendingOne,
  };
}

function MailApp() {
  const navigate = useNavigate();
  const { confirm } = useConfirm();
  const [session, setSession] = useState<MailSession | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeInitial | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);
  const [reading, setReading] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchMode, setSearchMode] = useState<"quick" | "deep">("quick");
  const [deepIncludeBody, setDeepIncludeBody] = useState(false);
  const [deepResults, setDeepResults] = useState<MailMessage[] | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);

  const {
    folder,
    setFolder,
    sort,
    setSort,
    counts,
    setCounts,
    messages,
    setMessages,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    bridgeError,
    useMock,
    loadCounts,
    refresh: rawRefresh,
    onAfterSend,
    setPendingFlagOverride,
    clearPendingFlagOverride,
    hideRow,
    unhideRow,
    confirmHideRow,
    beginStarMutation,
    endStarMutation,

    applyPendingOne,
  } = useMailData(session || null);

  // Serialize Refresh with a single-flight guard (ref, not React state) so a
  // double-click that fires before the next render can't spawn a second
  // incrementalNow. `refreshing` state stays as the visual spinner only.
  const refreshFlightRef = useRef(createSingleFlight<void>());
  const refresh = useCallback((): Promise<void> => {
    if (refreshFlightRef.current.isBusy()) {
      return refreshFlightRef.current.run(() => Promise.resolve());
    }
    setRefreshing(true);
    return refreshFlightRef.current.run(async () => {
      try {
        await rawRefresh();
      } finally {
        setRefreshing(false);
      }
    });
  }, [rawRefresh]);

  const getOne = useServerFn(bridgeGetMessage);
  const markRead = useServerFn(bridgeMarkRead);
  const star = useServerFn(bridgeStar);
  const updateFlag = useServerFn(indexUpdateFlag);
  const move = useServerFn(bridgeMove);
  const deleteFn = useServerFn(bridgeDelete);
  const moveIndex = useServerFn(indexMoveMessage);
  const deleteIndex = useServerFn(indexDeleteMessage);
  const searchFn = useServerFn(bridgeSearch);

  // Preferred path for \Seen / \Flagged mutations:
  //   session has mailSessionToken → indexUpdateFlag (IMAP + Local Index
  //   write-through in one round). Falls back to raw bridge for legacy
  //   sessions with no token. Throws on any failure so callers' optimistic
  //   rollback in .catch fires.
  const mutateFlag = useCallback(
    async (canonical: MailFolder, uid: number, kind: "seen" | "flagged", value: boolean) => {
      if (!session) throw new Error("لا توجد جلسة بريد");
      if (session.mailSessionToken) {
        const res = await updateFlag({
          data: {
            mailSessionToken: session.mailSessionToken,
            password: session.password,
            canonical,
            uid,
            kind,
            value,
          },
        });
        if (!res.ok) throw new Error(res.error);
        return;
      }
      if (kind === "seen") {
        await markRead({
          data: {
            account: session.account,
            password: session.password,
            folder: canonical,
            uid,
            read: value,
          },
        });
      } else {
        await star({
          data: {
            account: session.account,
            password: session.password,
            folder: canonical,
            uid,
            starred: value,
          },
        });
      }
    },
    [session, updateFlag, markRead, star],
  );

  // Move/Trash orchestration
  // ------------------------
  // Preferred path when a mail-session JWT is present: `indexMoveMessage`
  // performs Bridge move + Local Index write-through in one round and
  // throws on any failure (including bridge non-ok). Legacy sessions with
  // no token fall back to the raw bridge endpoints (`move` / `deleteFn`).
  const mutateMoveOrDelete = useCallback(
    async (params: {
      sourceCanonical: MailFolder;
      uid: number;
      /** Omit → permanent delete (only valid when sourceCanonical === "trash"). */
      toFolder?: MailFolder;
    }) => {
      if (!session) throw new Error("لا توجد جلسة بريد");
      const dest = params.toFolder;
      // Permanent-delete branch — MUST use indexDeleteMessage (Blocker 1).
      // Never delegates to moveIndex; the Bridge decider on "trash" would
      // otherwise take an unrelated code path.
      if (dest === undefined) {
        if (params.sourceCanonical !== "trash") {
          throw new Error("الحذف النهائي مسموح فقط من مجلد المهملات");
        }
        if (session.mailSessionToken) {
          const res = await deleteIndex({
            data: {
              mailSessionToken: session.mailSessionToken,
              password: session.password,
              canonical: "trash",
              uid: params.uid,
            },
          });
          if (!res.ok) throw new Error(res.error);
          return;
        }
        // Legacy fallback (no JWT): bridge /api/delete decides on trash → permanent.
        await deleteFn({
          data: {
            account: session.account,
            password: session.password,
            folder: params.sourceCanonical,
            uid: params.uid,
          },
        });
        return;
      }
      // Move branch — IMAP MOVE + local write-through in one round.
      if (session.mailSessionToken) {
        const res = await moveIndex({
          data: {
            mailSessionToken: session.mailSessionToken,
            password: session.password,
            sourceCanonical: params.sourceCanonical,
            destCanonical: dest,
            uid: params.uid,
          },
        });
        if (!res.ok) throw new Error(res.error);
        return;
      }
      await move({
        data: {
          account: session.account,
          password: session.password,
          folder: params.sourceCanonical,
          uid: params.uid,
          toFolder: dest,
        },
      });
    },
    [session, moveIndex, deleteIndex, deleteFn, move],
  );

  // Per-id single-flight guard against double-click on Move/Delete/Restore.
  // Same id in flight → returns the same promise instead of firing IMAP twice.
  const moveFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const runMoveFlight = useCallback(
    async (id: string, worker: () => Promise<void>): Promise<void> => {
      const existing = moveFlightRef.current.get(id);
      if (existing) return existing;
      const p = worker().finally(() => {
        moveFlightRef.current.delete(id);
      });
      moveFlightRef.current.set(id, p);
      return p;
    },
    [],
  );

  // In-memory caches for instant open (prefetch on hover)
  const messageCache = useRef<Map<string, MailMessage>>(new Map());
  const inflight = useRef<Map<string, Promise<MailMessage | null>>>(new Map());

  const fetchMessage = useCallback(
    (id: string): Promise<MailMessage | null> => {
      if (!session) return Promise.resolve(null);
      const cached = messageCache.current.get(id);
      if (cached) return Promise.resolve(cached);
      const existing = inflight.current.get(id);
      if (existing) return existing;
      const parsed = parseMessageId(id);
      if (!parsed) return Promise.resolve(null);
      const p = getOne({
        data: {
          account: session.account,
          password: session.password,
          folder: parsed.folder,
          uid: parsed.uid,
        },
      })
        .then((result) => {
          if (result.ok && result.message) {
            // Patch through pending overrides so a slow fetch response cannot
            // overwrite an in-flight optimistic star/read the user just set.
            const patched = applyPendingOne(result.message);
            messageCache.current.set(id, patched);
            return patched;
          }
          return null;
        })
        .catch(() => null)
        .finally(() => {
          inflight.current.delete(id);
        });
      inflight.current.set(id, p);
      return p;
    },
    [session, getOne, applyPendingOne],
  );

  const prefetchMessage = useCallback(
    (id: string) => {
      if (!messageCache.current.has(id) && !inflight.current.has(id)) {
        void fetchMessage(id);
      }
    },
    [fetchMessage],
  );

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

  // Clear message cache when switching folders (memory hygiene)
  useEffect(() => {
    messageCache.current.clear();
    inflight.current.clear();
    setSelection(new Set());
    setSelectMode(false);
  }, [folder]);

  // Clear deep search results when leaving deep mode or switching folder.
  useEffect(() => {
    setDeepResults(null);
    setDeepError(null);
  }, [folder, searchMode]);

  // Debounced server-side search — only fires in "deep" mode with 2+ chars.
  // Uses IMAP SEARCH on the origin server (headers by default, optional BODY).
  useEffect(() => {
    if (searchMode !== "deep" || !session) return;
    const q = query.trim();
    if (q.length < 2) {
      setDeepResults(null);
      setDeepError(null);
      setDeepLoading(false);
      return;
    }
    let cancelled = false;
    setDeepLoading(true);
    setDeepError(null);
    const t = setTimeout(async () => {
      try {
        const res = await searchFn({
          data: {
            account: session.account,
            password: session.password,
            folder,
            query: q,
            includeBody: deepIncludeBody,
            limit: 100,
          },
        });
        if (cancelled) return;
        if (res.ok) setDeepResults(res.messages.map(applyPendingOne));
        else {
          setDeepResults([]);
          setDeepError(res.error || "فشل البحث على السيرفر");
        }
      } catch (err: any) {
        if (!cancelled) {
          setDeepResults([]);
          setDeepError(err?.message || "فشل البحث على السيرفر");
        }
      } finally {
        if (!cancelled) setDeepLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, searchMode, deepIncludeBody, folder, session, searchFn]);

  const filteredMessages = useMemo(() => {
    // Deep server-side search: always show server results (even empty).
    if (searchMode === "deep" && query.trim().length >= 2) {
      return deepResults ?? [];
    }
    if (!query.trim()) return messages;
    const q = query.toLowerCase();
    return messages.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.from.name.toLowerCase().includes(q) ||
        m.from.email.toLowerCase().includes(q) ||
        m.preview.toLowerCase().includes(q),
    );
  }, [messages, query, searchMode, deepResults]);
  const inDeepSearch = searchMode === "deep" && query.trim().length >= 2;

  async function openMessage(id: string) {
    setSelectedId(id);
    const parsed = parseMessageId(id);
    if (!parsed || !session) {
      setSelectedMessage(getMockMessage(id) ?? null);
      return;
    }
    const cached = messageCache.current.get(id);
    if (cached) {
      // Instant open (0ms perceived latency)
      setSelectedMessage(cached);
      setReading(false);
    } else {
      setSelectedMessage(null);
      setReading(true);
    }
    try {
      const msg = await fetchMessage(id);
      if (msg) setSelectedMessage(msg);
      else if (!cached) throw new Error("فشل فتح الرسالة");

      const listMsg = messages.find((m) => m.id === id);
      if (listMsg && !listMsg.read) {
        // Optimistic read
        setPendingFlagOverride(id, { read: true });
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: true } : m)));
        setCounts((prev) => {
          const cur = prev[parsed.folder];
          if (!cur || cur.unread <= 0) return prev;
          return { ...prev, [parsed.folder]: { ...cur, unread: cur.unread - 1 } };
        });
        const c = messageCache.current.get(id);
        if (c) messageCache.current.set(id, { ...c, read: true });
        mutateFlag(parsed.folder, parsed.uid, "seen", true).catch(() => {
          clearPendingFlagOverride(id, "read");
        });
      }
    } catch (err: any) {
      if (!cached) {
        toast.error(err?.message || "فشل فتح الرسالة");
        setSelectedMessage(getMockMessage(id) ?? null);
      }
    } finally {
      setReading(false);
    }
  }

  async function toggleStar(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    // Prev value from the ACTUALLY VISIBLE source: Deep Search overrides the
    // regular list, and messages the row may not exist in at all.
    const inDeep = searchMode === "deep" && query.trim().length >= 2;
    const source = inDeep && deepResults ? deepResults : messages;
    const msg = source.find((m) => m.id === id);
    const nextStarred = !msg?.starred;
    // Record expected value first so any in-flight list write (background
    // sync, refresh, pagination, deep search) cannot clobber it.
    setPendingFlagOverride(id, { starred: nextStarred });
    // V4: mark the star-count "hot" so any concurrent counts loader keeps
    // the optimistic value instead of the still-stale server total.
    beginStarMutation();
    // Optimistic counter — starred.total moves by exactly one and never
    // dips below zero. Rolled back below on failure via the inverse delta.
    setCounts((prev) => {
      const cur = prev.starred;
      if (!cur) return prev;
      const delta = nextStarred ? 1 : -1;
      return { ...prev, starred: { ...cur, total: Math.max(0, cur.total + delta) } };
    });
    // Snapshot for potential rollback (used when we optimistically REMOVE
    // the row from the "starred" folder view on unstar).
    let starredFolderSnapshot: { list: MailMessage[]; index: number } | null = null;
    if (folder === "starred" && !nextStarred) {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx >= 0) {
        starredFolderSnapshot = { list: messages, index: idx };
        hideRow(id);
        setMessages((prev) => prev.filter((m) => m.id !== id));
      }
    } else {
      // Re-starring anywhere: clear any hide for THIS id and, crucially,
      // clear the "starred:<uid>" namespaced hide too — the row might
      // have been unstarred from the Starred view earlier and its hide
      // entry is keyed by that folder-prefixed id. Without this, the
      // freshly-restarred row would still be filtered out of the Starred
      // view on next visit.
      unhideRow(id);
      if (parsed.folder !== "starred") {
        unhideRow(`starred:${parsed.uid}`);
      }
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, starred: nextStarred } : m)));
    }
    setDeepResults((prev) =>
      prev ? prev.map((m) => (m.id === id ? { ...m, starred: nextStarred } : m)) : prev,
    );
    const cached = messageCache.current.get(id);
    if (cached) messageCache.current.set(id, { ...cached, starred: nextStarred });
    try {
      await mutateFlag(parsed.folder, parsed.uid, "flagged", nextStarred);
      // IMAP + Local Index write-through succeeded. If we optimistically
      // hid a row in the Starred view, mark the hide as CONFIRMED so the
      // next primary list load (which is guaranteed to reflect the flag
      // flip) auto-drops it via gcHiddenBefore. A pre-mutation racing
      // response still can't resurrect the row in the meantime.
      if (starredFolderSnapshot) {
        confirmHideRow(id, Date.now());
      }
    } catch (err: any) {
      clearPendingFlagOverride(id, "starred");
      // Rollback counter with the inverse delta (single, exact revert).
      setCounts((prev) => {
        const cur = prev.starred;
        if (!cur) return prev;
        const delta = nextStarred ? -1 : 1;
        return { ...prev, starred: { ...cur, total: Math.max(0, cur.total + delta) } };
      });
      if (starredFolderSnapshot) {
        // Restore the row at its previous position, then unhide.
        // Duplicate guard: a racing sync may have already re-inserted
        // the row while the mutation was in flight — never insert twice.
        unhideRow(id);
        const { list, index } = starredFolderSnapshot;
        const revived = list[index];
        setMessages((prev) => {
          if (prev.some((m) => m.id === id)) return prev;
          const next = prev.slice();
          const clampedIdx = Math.min(index, next.length);
          next.splice(clampedIdx, 0, revived);
          return next;
        });
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, starred: !nextStarred } : m)),
        );
      }
      setDeepResults((prev) =>
        prev ? prev.map((m) => (m.id === id ? { ...m, starred: !nextStarred } : m)) : prev,
      );
      const c = messageCache.current.get(id);
      if (c) messageCache.current.set(id, { ...c, starred: !nextStarred });
      toast.error(err?.message || "فشل تحديث المميّز");
    } finally {
      // V4: always release the star-count "hot" window, success or failure.
      endStarMutation();
    }
  }



  async function toggleRead(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    const nextRead = !msg.read;
    setPendingFlagOverride(id, { read: nextRead });
    // Optimistic
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: nextRead } : m)));
    setDeepResults((prev) =>
      prev ? prev.map((m) => (m.id === id ? { ...m, read: nextRead } : m)) : prev,
    );
    const cached = messageCache.current.get(id);
    if (cached) messageCache.current.set(id, { ...cached, read: nextRead });
    setCounts((prev) => {
      const cur = prev[parsed.folder];
      if (!cur) return prev;
      const delta = nextRead ? -1 : 1;
      const unread = Math.max(0, cur.unread + delta);
      return { ...prev, [parsed.folder]: { ...cur, unread } };
    });
    try {
      await mutateFlag(parsed.folder, parsed.uid, "seen", nextRead);
    } catch (err: any) {
      // Revert both flag and counter.
      clearPendingFlagOverride(id, "read");
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: !nextRead } : m)));
      setDeepResults((prev) =>
        prev ? prev.map((m) => (m.id === id ? { ...m, read: !nextRead } : m)) : prev,
      );
      const c = messageCache.current.get(id);
      if (c) messageCache.current.set(id, { ...c, read: !nextRead });
      setCounts((prev) => {
        const cur = prev[parsed.folder];
        if (!cur) return prev;
        const delta = nextRead ? 1 : -1;
        const unread = Math.max(0, cur.unread + delta);
        return { ...prev, [parsed.folder]: { ...cur, unread } };
      });
      toast.error(err?.message || "فشل تحديث حالة القراءة");
    }
  }

  // Optimistic-count helper for Move/Trash/Restore. `from` decreases by 1
  // (and unread by 1 if the message was unread). `to` is symmetric. Both
  // clamp at 0 so a stale counter never goes negative.
  function applyMoveCountsDelta(
    from: MailFolder,
    to: MailFolder | null,
    wasUnread: boolean,
  ) {
    setCounts((prev) => {
      const next = { ...prev };
      const src = next[from];
      if (src) {
        next[from] = {
          ...src,
          total: Math.max(0, src.total - 1),
          unread: Math.max(0, src.unread - (wasUnread ? 1 : 0)),
        };
      }
      if (to && next[to]) {
        const d = next[to];
        next[to] = {
          ...d,
          total: d.total + 1,
          unread: d.unread + (wasUnread ? 1 : 0),
        };
      }
      return next;
    });
  }

  async function handleMove(id: string, toFolder: MailFolder) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    return runMoveFlight(id, async () => {
      const msg = messages.find((m) => m.id === id);
      const wasUnread = msg ? !msg.read : false;
      const snapshot = messages;
      const prevSelectedId = selectedId;
      const prevSelected = selectedMessage;
      // Optimistic — hide row, drop selection, adjust counters.
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setSelectedId(null);
      setSelectedMessage(null);
      messageCache.current.delete(id);
      hideRow(id);
      applyMoveCountsDelta(parsed.folder, toFolder, wasUnread);
      try {
        await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder,
        });
        if (toFolder === "trash") rememberOrigin(msg?.threadId, parsed.folder);
        else forgetOrigin(msg?.threadId);
        confirmHideRow(id);
        toast.success("تم نقل الرسالة");
      } catch (err: any) {
        unhideRow(id);
        applyMoveCountsDelta(toFolder, parsed.folder, wasUnread); // revert
        setMessages(snapshot);
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
        toast.error(err?.message || "فشل نقل الرسالة");
      }
    });
  }

  async function handleDelete(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    const msg = messages.find((m) => m.id === id);
    const isTrash = parsed.folder === "trash";
    const confirmed = await confirm({
      title: isTrash ? "حذف نهائي" : "نقل إلى المهملات",
      description: isTrash
        ? "هل أنت متأكد من حذف هذه الرسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء."
        : "هل أنت متأكد من نقل هذه الرسالة إلى المهملات؟",
      confirmLabel: isTrash ? "حذف" : "نقل",
      cancelLabel: "إلغاء",
      variant: isTrash ? "destructive" : "default",
    });
    if (!confirmed) return;
    return runMoveFlight(id, async () => {
      const wasUnread = msg ? !msg.read : false;
      const snapshot = messages;
      const deepSnapshot = deepResults;
      const prevSelectedId = selectedId;
      const prevSelected = selectedMessage;
      // Trash-delete = permanent delete via indexDeleteMessage / bridge
      // messageDelete (Blocker 1). No target folder gains a row, so
      // counters model source-1 only. Ghost prevention: also purge from
      // deep-search results — the tombstone will keep it out of the next
      // index page, and this covers the currently-visible in-memory list.
      const destForCounts: MailFolder | null = isTrash ? null : "trash";
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (isTrash) {
        setDeepResults((prev) => (prev ? prev.filter((m) => m.id !== id) : prev));
      }
      setSelectedId(null);
      setSelectedMessage(null);
      messageCache.current.delete(id);
      hideRow(id);
      applyMoveCountsDelta(parsed.folder, destForCounts, wasUnread);
      try {
        if (isTrash) {
          await mutateMoveOrDelete({ sourceCanonical: parsed.folder, uid: parsed.uid });
          forgetOrigin(msg?.threadId);
        } else {
          await mutateMoveOrDelete({
            sourceCanonical: parsed.folder,
            uid: parsed.uid,
            toFolder: "trash",
          });
          rememberOrigin(msg?.threadId, parsed.folder);
        }
        confirmHideRow(id);
        toast.success(isTrash ? "تم حذف الرسالة نهائياً" : "تم نقل الرسالة إلى المهملات");
      } catch (err: any) {
        unhideRow(id);
        applyMoveCountsDelta(destForCounts ?? parsed.folder, parsed.folder, wasUnread); // revert
        setMessages(snapshot);
        if (isTrash) setDeepResults(deepSnapshot);
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
        toast.error(err?.message || (isTrash ? "فشل حذف الرسالة" : "فشل نقل الرسالة إلى المهملات"));
      }
    });
  }

  async function handleRestore(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    if (parsed.folder !== "trash") return;
    return runMoveFlight(id, async () => {
      const msg = messages.find((m) => m.id === id);
      const wasUnread = msg ? !msg.read : false;
      const target = getOrigin(msg?.threadId);
      const snapshot = messages;
      const prevSelectedId = selectedId;
      const prevSelected = selectedMessage;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setSelectedId(null);
      setSelectedMessage(null);
      messageCache.current.delete(id);
      hideRow(id);
      applyMoveCountsDelta(parsed.folder, target, wasUnread);
      try {
        await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder: target,
        });
        forgetOrigin(msg?.threadId);
        confirmHideRow(id);
        const label = FOLDER_META[target]?.label || target;
        toast.success(`تم استعادة الرسالة إلى ${label}`);
      } catch (err: any) {
        unhideRow(id);
        applyMoveCountsDelta(target, parsed.folder, wasUnread); // revert
        setMessages(snapshot);
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
        toast.error(err?.message || "فشل استعادة الرسالة");
      }
    });
  }

  async function handleMarkUnread(id: string) {
    const parsed = parseMessageId(id);
    if (!parsed || !session) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, read: false } : m)));
    setCounts((prev) => {
      const cur = prev[parsed.folder];
      if (!cur) return prev;
      return { ...prev, [parsed.folder]: { ...cur, unread: cur.unread + 1 } };
    });
    const c = messageCache.current.get(id);
    if (c) messageCache.current.set(id, { ...c, read: false });
    setSelectedId(null);
    setSelectedMessage(null);
    try {
      await mutateFlag(parsed.folder, parsed.uid, "seen", false);
    } catch (err: any) {
      toast.error(err?.message || "فشل التعليم كغير مقروءة");
    }
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
    setSelection((prev) => {
      if (prev.size >= filteredMessages.length && filteredMessages.length > 0) {
        return new Set();
      }
      return new Set(filteredMessages.map((m) => m.id));
    });
  }

  function clearSelection() {
    setSelection(new Set());
  }

  function toggleSelectMode() {
    setSelectMode((v) => {
      if (v) clearSelection();
      return !v;
    });
  }

  // Run async ops with limited concurrency to stay fast without hammering the bridge
  async function runBatch<T>(items: T[], limit: number, worker: (item: T) => Promise<any>) {
    let idx = 0;
    let failed = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try {
          await worker(items[i]);
        } catch {
          failed++;
        }
      }
    });
    await Promise.all(runners);
    return { failed };
  }

  // Bulk helper: capture per-id metadata BEFORE we clear the selection or
  // filter the list, so a per-id rollback can rebuild counters correctly.
  function collectBulkMeta(ids: string[]) {
    const set = new Set(ids);
    const meta = new Map<string, { threadId?: string; wasUnread: boolean }>();
    for (const m of messages) {
      if (set.has(m.id)) meta.set(m.id, { threadId: m.threadId, wasUnread: !m.read });
    }
    return meta;
  }

  async function bulkMove(toFolder: MailFolder) {
    if (!session || selection.size === 0 || bulkBusy) return;
    const ids = Array.from(selection);
    const meta = collectBulkMeta(ids);
    const snapshot = messages;
    const prevSelectedId = selectedId;
    const prevSelected = selectedMessage;
    setBulkBusy(true);
    setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
    if (prevSelectedId && selection.has(prevSelectedId)) {
      setSelectedId(null);
      setSelectedMessage(null);
    }
    ids.forEach((id) => {
      messageCache.current.delete(id);
      hideRow(id);
    });
    // Optimistic counter deltas per id (source folder inferred from id).
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (!parsed) continue;
      const info = meta.get(id);
      applyMoveCountsDelta(parsed.folder, toFolder, info?.wasUnread ?? false);
    }
    clearSelection();
    const failedIds: string[] = [];
    await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      try {
        await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder,
        });
        if (toFolder === "trash") rememberOrigin(meta.get(id)?.threadId, parsed.folder);
        else forgetOrigin(meta.get(id)?.threadId);
        confirmHideRow(id);
      } catch (err) {
        failedIds.push(id);
        throw err;
      }
    });
    setBulkBusy(false);
    if (failedIds.length > 0) {
      // Per-id rollback: restore rows + counters for failed ids only.
      const failedSet = new Set(failedIds);
      for (const id of failedIds) {
        unhideRow(id);
        const parsed = parseMessageId(id);
        if (parsed) {
          const info = meta.get(id);
          applyMoveCountsDelta(toFolder, parsed.folder, info?.wasUnread ?? false); // revert
        }
      }
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const revived = snapshot.filter((m) => failedSet.has(m.id) && !seen.has(m.id));
        return revived.length ? [...revived, ...prev] : prev;
      });
      if (prevSelectedId && failedSet.has(prevSelectedId)) {
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
      }
      toast.error(`فشل نقل ${failedIds.length} من ${ids.length} رسالة`);
    } else {
      toast.success(`تم نقل ${ids.length} رسالة`);
    }
  }

  async function bulkDelete() {
    if (!session || selection.size === 0 || bulkBusy) return;
    const ids = Array.from(selection);
    const isTrash = folder === "trash";
    const confirmed = await confirm({
      title: isTrash ? "حذف نهائي" : "نقل إلى المهملات",
      description: isTrash
        ? `هل أنت متأكد من حذف ${ids.length} رسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`
        : `هل أنت متأكد من نقل ${ids.length} رسالة إلى المهملات؟`,
      confirmLabel: isTrash ? "حذف" : "نقل",
      cancelLabel: "إلغاء",
      variant: isTrash ? "destructive" : "default",
    });
    if (!confirmed) return;
    const meta = collectBulkMeta(ids);
    const snapshot = messages;
    const prevSelectedId = selectedId;
    const prevSelected = selectedMessage;
    setBulkBusy(true);
    setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
    if (prevSelectedId && selection.has(prevSelectedId)) {
      setSelectedId(null);
      setSelectedMessage(null);
    }
    ids.forEach((id) => {
      messageCache.current.delete(id);
      hideRow(id);
    });
    const destForCounts: MailFolder | null = isTrash ? null : "trash";
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (!parsed) continue;
      const info = meta.get(id);
      applyMoveCountsDelta(parsed.folder, destForCounts, info?.wasUnread ?? false);
    }
    clearSelection();
    const failedIds: string[] = [];
    await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      try {
        if (isTrash) {
          await mutateMoveOrDelete({ sourceCanonical: parsed.folder, uid: parsed.uid });
          forgetOrigin(meta.get(id)?.threadId);
        } else {
          await mutateMoveOrDelete({
            sourceCanonical: parsed.folder,
            uid: parsed.uid,
            toFolder: "trash",
          });
          rememberOrigin(meta.get(id)?.threadId, parsed.folder);
        }
        confirmHideRow(id);
      } catch (err) {
        failedIds.push(id);
        throw err;
      }
    });
    setBulkBusy(false);
    if (failedIds.length > 0) {
      const failedSet = new Set(failedIds);
      for (const id of failedIds) {
        unhideRow(id);
        const parsed = parseMessageId(id);
        if (parsed) {
          const info = meta.get(id);
          applyMoveCountsDelta(destForCounts ?? parsed.folder, parsed.folder, info?.wasUnread ?? false); // revert
        }
      }
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const revived = snapshot.filter((m) => failedSet.has(m.id) && !seen.has(m.id));
        return revived.length ? [...revived, ...prev] : prev;
      });
      if (prevSelectedId && failedSet.has(prevSelectedId)) {
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
      }
      toast.error(
        isTrash
          ? `فشل حذف ${failedIds.length} من ${ids.length} رسالة`
          : `فشل نقل ${failedIds.length} من ${ids.length} رسالة إلى المهملات`,
      );
    } else {
      toast.success(
        isTrash ? `تم حذف ${ids.length} رسالة` : `تم نقل ${ids.length} رسالة إلى المهملات`,
      );
    }
  }

  async function bulkRestore() {
    if (!session || selection.size === 0 || bulkBusy) return;
    if (folder !== "trash") return;
    const ids = Array.from(selection);
    const meta = collectBulkMeta(ids);
    const snapshot = messages;
    const prevSelectedId = selectedId;
    const prevSelected = selectedMessage;
    setBulkBusy(true);
    setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
    if (prevSelectedId && selection.has(prevSelectedId)) {
      setSelectedId(null);
      setSelectedMessage(null);
    }
    ids.forEach((id) => {
      messageCache.current.delete(id);
      hideRow(id);
    });
    // Precompute targets from origin map for both delta application and rollback.
    const idToTarget = new Map<string, MailFolder>();
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (!parsed) continue;
      const target = getOrigin(meta.get(id)?.threadId);
      idToTarget.set(id, target);
      applyMoveCountsDelta(parsed.folder, target, meta.get(id)?.wasUnread ?? false);
    }
    clearSelection();
    const failedIds: string[] = [];
    await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      const target = idToTarget.get(id)!;
      try {
        await mutateMoveOrDelete({
          sourceCanonical: parsed.folder,
          uid: parsed.uid,
          toFolder: target,
        });
        forgetOrigin(meta.get(id)?.threadId);
        confirmHideRow(id);
      } catch (err) {
        failedIds.push(id);
        throw err;
      }
    });
    setBulkBusy(false);
    if (failedIds.length > 0) {
      const failedSet = new Set(failedIds);
      for (const id of failedIds) {
        unhideRow(id);
        const parsed = parseMessageId(id);
        if (parsed) {
          const target = idToTarget.get(id);
          if (target) {
            applyMoveCountsDelta(target, parsed.folder, meta.get(id)?.wasUnread ?? false); // revert
          }
        }
      }
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const revived = snapshot.filter((m) => failedSet.has(m.id) && !seen.has(m.id));
        return revived.length ? [...revived, ...prev] : prev;
      });
      if (prevSelectedId && failedSet.has(prevSelectedId)) {
        setSelectedId(prevSelectedId);
        setSelectedMessage(prevSelected);
      }
      toast.error(`فشل استعادة ${failedIds.length} من ${ids.length} رسالة`);
    } else {
      toast.success(`تم استعادة ${ids.length} رسالة`);
    }
  }


  async function bulkMarkUnread() {
    if (!session || selection.size === 0 || bulkBusy) return;
    const ids = Array.from(selection);
    setBulkBusy(true);
    setMessages((prev) => prev.map((m) => (selection.has(m.id) ? { ...m, read: false } : m)));
    ids.forEach((id) => {
      const c = messageCache.current.get(id);
      if (c) messageCache.current.set(id, { ...c, read: false });
    });
    clearSelection();
    const { failed } = await runBatch(ids, 5, async (id) => {
      const parsed = parseMessageId(id);
      if (!parsed) return;
      await mutateFlag(parsed.folder, parsed.uid, "seen", false);
    });
    setBulkBusy(false);
    if (failed > 0) toast.error(`فشل تعليم ${failed} رسالة`);
    else toast.success(`تم تعليم ${ids.length} رسالة كغير مقروءة`);
    loadCountsSoft();
  }

  function loadCountsSoft() {
    // Refresh counters only — never touch messages or sort order.
    setTimeout(() => loadCounts(), 300);
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

        <div className="mx-2 flex flex-1 items-center gap-1 rounded-xl bg-muted/70 pe-1 ps-3 py-1.5 transition focus-within:bg-card focus-within:shadow-elevated sm:mx-4 sm:max-w-xl">
          {searchMode === "deep" ? (
            deepLoading ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : (
              <Globe className="h-4 w-4 shrink-0 text-primary" />
            )
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchMode === "deep" ? "بحث شامل على السيرفر…" : "ابحث في البريد..."}
            className="w-full bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="مسح"
              aria-label="مسح"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <DropdownMenu dir="rtl">
            <DropdownMenuTrigger asChild>
              <button
                className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${
                  searchMode === "deep"
                    ? "bg-primary/10 text-primary hover:bg-primary/15"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                title="خيارات البحث"
              >
                {searchMode === "deep" ? (
                  <Globe className="h-3.5 w-3.5" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">{searchMode === "deep" ? "شامل" : "سريع"}</span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
                نمط البحث
              </div>
              <DropdownMenuItem
                onSelect={() => setSearchMode("quick")}
                className="flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">بحث سريع</span>
                    {searchMode === "quick" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    فوري في الرسائل المعروضة — دون أي طلب للسيرفر
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setSearchMode("deep")}
                className="flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <Globe className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">بحث شامل على السيرفر</span>
                    {searchMode === "deep" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    IMAP SEARCH على كامل المجلد الحالي (الموضوع + المرسل + المستلمين)
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  if (searchMode !== "deep") setSearchMode("deep");
                  setDeepIncludeBody((v) => !v);
                }}
                className="flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border">
                  {deepIncludeBody && <Check className="h-3 w-3 text-primary" />}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">تضمين نص الرسالة</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    أبطأ لكنه يبحث داخل محتوى الرسائل أيضاً
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <div
            className="hidden max-w-[200px] truncate rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground md:inline-block"
            dir="ltr"
            title={session.account.email_address}
          >
            {session.account.email_address}
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-70 sm:inline-flex"
            title="تحديث البريد"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
            <span className="hidden lg:inline">{refreshing ? "جاري التحديث..." : "تحديث"}</span>
          </button>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="rounded-lg p-2 hover:bg-muted disabled:opacity-70 sm:hidden"
            aria-label="تحديث"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}`} />
          </button>
          <button
            onClick={handleSignOut}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:inline-flex"
            title="تسجيل الخروج"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden lg:inline">خروج</span>
          </button>
          <button
            onClick={handleSignOut}
            className="rounded-lg p-2 hover:bg-muted sm:hidden"
            aria-label="خروج"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
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
                setCompose({});
                setSidebarOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-2xl bg-brand-gradient px-5 py-3.5 text-sm font-semibold text-white shadow-brand transition hover:scale-[1.02]"
            >
              <Pencil className="h-4 w-4" />
              رسالة جديدة
            </button>
          </div>

          <nav className="px-2">
            {(Object.keys(FOLDER_META) as MailFolder[])
              .filter((f) => counts[f]?.supported !== false)
              .map((f) => {
                const meta = FOLDER_META[f];
                const active = f === folder;
                const Icon = meta.icon;
                const { total } = counts[f] || { total: 0 };
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
            selectedMessage || (selectedId && reading) ? "hidden md:flex" : "flex"
          }`}
        >
          {selectMode || selection.size > 0 ? (
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-accent/40 px-4 text-xs">
              <button
                onClick={toggleSelectAllVisible}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted"
                title={
                  selection.size >= filteredMessages.length && filteredMessages.length > 0
                    ? "إلغاء التحديد"
                    : "تحديد الكل"
                }
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
                {selection.size > 0 ? `${selection.size} محددة` : "اختر الرسائل"}
              </span>
              <div className="flex-1" />
              {bulkBusy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {selection.size > 0 && (
                <DropdownMenu dir="rtl">
                  <DropdownMenuTrigger asChild>
                    <button
                      disabled={bulkBusy}
                      className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
                      title="إجراءات"
                    >
                      <MoreVertical className="h-4 w-4" />
                      <span>إجراءات</span>
                    </button>
                  </DropdownMenuTrigger>

                  <DropdownMenuContent align="start" className="w-56">
                    {folder === "trash" && (
                      <>
                        <DropdownMenuItem
                          onClick={bulkRestore}
                          disabled={bulkBusy}
                          className="cursor-pointer hover:bg-accent focus:bg-accent"
                        >
                          <ArchiveRestore className="ms-2 h-4 w-4" />
                          استعادة المحدد
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      onClick={() => bulkMove("archive")}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <Archive className="ms-2 h-4 w-4" />
                      أرشفة المحدد
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => bulkMove("spam")}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <AlertOctagon className="ms-2 h-4 w-4" />
                      نقل إلى المزعج
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={bulkMarkUnread}
                      disabled={bulkBusy}
                      className="cursor-pointer hover:bg-accent focus:bg-accent"
                    >
                      <MailIcon className="ms-2 h-4 w-4" />
                      تعليم كغير مقروءة
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={bulkDelete}
                      disabled={bulkBusy}
                      className="cursor-pointer text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:text-destructive"
                    >
                      <Trash2 className="ms-2 h-4 w-4" />
                      {folder === "trash" ? "حذف نهائياً" : "نقل إلى المهملات"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <button
                onClick={toggleSelectMode}
                disabled={bulkBusy}
                className="rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                title="إلغاء التحديد"
              >
                إلغاء
              </button>
            </div>
          ) : (
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4 text-xs">
              <div className="flex items-center gap-3">
                {selectMode && (
                  <button
                    onClick={toggleSelectAllVisible}
                    disabled={filteredMessages.length === 0}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
                    title="تحديد الكل"
                  >
                    <Square className="h-5 w-5 text-muted-foreground" />
                  </button>
                )}
                <span className="font-semibold text-muted-foreground">
                  {inDeepSearch ? (
                    <span className="flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5 text-primary" />
                      <span>
                        نتائج السيرفر · {filteredMessages.length}
                        {deepIncludeBody && (
                          <span className="ms-1 text-[10px] text-primary/70">(يشمل المحتوى)</span>
                        )}
                      </span>
                    </span>
                  ) : (
                    <>المعروضة · {filteredMessages.length}</>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <button
                  onClick={toggleSelectMode}
                  className={`rounded px-2 py-1.5 text-xs font-medium transition ${
                    selectMode
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "text-foreground hover:bg-muted"
                  }`}
                >
                  {selectMode ? "إلغاء" : "تحديد"}
                </button>
                {!inDeepSearch && (
                  <DropdownMenu dir="rtl">
                    <DropdownMenuTrigger asChild>
                      <button
                        className="flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                        title="ترتيب العرض"
                      >
                        <ArrowUpDown className="h-3.5 w-3.5" />
                        <span>ترتيب</span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      {(
                        [
                          { value: "date-desc", label: "الأحدث أولاً" },
                          { value: "date-asc", label: "الأقدم أولاً" },
                          { value: "unread-first", label: "غير المقروءة أولاً" },
                          { value: "starred-first", label: "المميّزة بنجمة أولاً" },
                        ] as { value: SortOption; label: string }[]
                      ).map((opt, i) => {
                        const disabled = folder === "starred" && opt.value === "starred-first";
                        return (
                          <div key={opt.value}>
                            {i > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuItem
                              disabled={disabled}
                              onClick={() => !disabled && setSort(opt.value)}
                              className="flex items-center justify-between gap-2 hover:bg-accent focus:bg-accent"
                            >
                              <span>{opt.label}</span>
                              {sort === opt.value && <Check className="h-4 w-4 text-primary" />}
                            </DropdownMenuItem>
                          </div>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            {(loading || (inDeepSearch && deepLoading)) && filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                {inDeepSearch && (
                  <p className="text-xs text-muted-foreground">جاري البحث على السيرفر…</p>
                )}
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <MailIcon className="h-10 w-10 opacity-30" />
                {inDeepSearch ? (
                  <>
                    <p className="text-sm">{deepError ? deepError : "لا توجد نتائج على السيرفر"}</p>
                    {!deepError && !deepIncludeBody && (
                      <p className="text-[11px] text-muted-foreground/70">
                        جرّب تفعيل «تضمين نص الرسالة» من خيارات البحث
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm">لا توجد رسائل هنا</p>
                )}
              </div>
            ) : (
              <Virtuoso
                style={{ height: "100%" }}
                data={filteredMessages}
                overscan={800}
                increaseViewportBy={{ top: 400, bottom: 800 }}
                computeItemKey={(_, m) => m.id}
                endReached={() => {
                  if (!query.trim() && !inDeepSearch) void loadMore();
                }}
                itemContent={(_, m) => (
                  <MessageRow
                    message={m}
                    active={m.id === selectedId}
                    selected={selection.has(m.id)}
                    anySelected={selection.size > 0}
                    selectMode={selectMode}
                    onClick={() => {
                      if (selectMode) toggleSelect(m.id);
                      else openMessage(m.id);
                    }}
                    onPrefetch={() => prefetchMessage(m.id)}
                    onToggleStar={(e) => toggleStar(e, m.id)}
                    onToggleRead={(e) => toggleRead(e, m.id)}
                    onToggleSelect={() => toggleSelect(m.id)}
                  />
                )}
                components={{
                  Footer: () =>
                    loadingMore ? (
                      <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> جاري تحميل المزيد…
                      </div>
                    ) : !hasMore && filteredMessages.length > 0 ? (
                      <div className="py-4 text-center text-[11px] text-muted-foreground">
                        — نهاية الرسائل —
                      </div>
                    ) : null,
                }}
              />
            )}
          </div>
        </div>

        {/* Message viewer */}
        <div
          className={`flex-1 overflow-hidden bg-surface ${
            selectedMessage || (selectedId && reading) ? "flex" : "hidden md:flex"
          } flex-col`}
        >
          {selectedMessage ? (
            <MessageView
              message={selectedMessage}
              loading={reading}
              myEmail={session.account.email_address}
              onBack={() => {
                setSelectedId(null);
                setSelectedMessage(null);
              }}
              onReply={() =>
                setCompose(buildReply(selectedMessage, session.account.email_address, false))
              }
              onReplyAll={() =>
                setCompose(buildReply(selectedMessage, session.account.email_address, true))
              }
              onForward={() => setCompose(buildForward(selectedMessage))}
              onArchive={() => handleMove(selectedMessage.id, "archive")}
              onDelete={() => handleDelete(selectedMessage.id)}
              onSpam={() => handleMove(selectedMessage.id, "spam")}
              onMarkUnread={() => handleMarkUnread(selectedMessage.id)}
              onRestore={() => handleRestore(selectedMessage.id)}
              onPrint={() => {
                /* handled inside MessageView */
              }}
            />
          ) : selectedId && reading ? (
            <LoadingViewer
              onBack={() => {
                setSelectedId(null);
                setSelectedMessage(null);
              }}
            />
          ) : (
            <EmptyViewer />
          )}
        </div>
      </div>

      {compose && (
        <Composer
          session={session}
          initial={compose}
          onClose={() => setCompose(null)}
          onSent={onAfterSend}
        />
      )}
    </div>
  );
}

function MessageRow({
  message,
  active,
  selected,
  anySelected,
  selectMode,
  onClick,
  onPrefetch,
  onToggleStar,
  onToggleRead,
  onToggleSelect,
}: {
  message: MailMessage;
  active: boolean;
  selected: boolean;
  anySelected: boolean;
  selectMode: boolean;
  onClick: () => void;
  onPrefetch?: () => void;
  onToggleStar: (e: React.MouseEvent) => void;
  onToggleRead: (e: React.MouseEvent) => void;
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
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onTouchStart={onPrefetch}
      className={`group flex w-full cursor-pointer items-start gap-3 border-b border-border/60 px-4 py-3 text-right transition-colors duration-150 hover:bg-muted/50 active:bg-muted active:duration-75 ${
        active ? "bg-accent" : ""
      } ${selected ? "bg-primary/5" : ""} ${!message.read ? "bg-card" : "bg-card/70"}`}
    >
      {/* Avatar doubles as selection checkbox so no extra layout shift occurs */}
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white transition ${
            selectMode || selected ? "opacity-0" : "opacity-100"
          }`}
        >
          {message.from.name.charAt(0) || message.from.email.charAt(0)}
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
          title={selected ? "إلغاء التحديد" : "تحديد"}
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
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar(e);
            }}
            className={`rounded p-0.5 hover:bg-muted ${message.starred ? "text-star" : "text-muted-foreground"}`}
            title={message.starred ? "إزالة المميّز" : "تمييز"}
          >
            <Star className={`h-3.5 w-3.5 ${message.starred ? "fill-star" : ""}`} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleRead(e);
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={message.read ? "تعليم كغير مقروءة" : "تعليم كمقروءة"}
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
  loading,
  myEmail,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
  onSpam,
  onMarkUnread,
  onRestore,
  onPrint,
}: {
  message: MailMessage;
  loading: boolean;
  myEmail: string;
  onBack: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSpam: () => void;
  onMarkUnread: () => void;
  onRestore: () => void;
  onPrint: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const recipientsAll = [
    ...message.to.map((t) => ({ ...t, kind: "to" as const })),
    ...(message.cc || []).map((c) => ({ ...c, kind: "cc" as const })),
  ];
  const toSummary = recipientsAll.length > 0 ? recipientsAll.map((r) => r.email).join("، ") : "—";

  const fullDate = new Date(message.date).toLocaleString("ar", {
    dateStyle: "full",
    timeStyle: "short",
  });
  const isTrash = message.folder === "trash";
  const isSecure = !!message.security && !/غير/.test(message.security);

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(message.from.email);
      toast.success("تم نسخ البريد");
    } catch {
      toast.error("تعذّر النسخ");
    }
  }

  function printMessage() {
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) {
      toast.error("تعذّر فتح نافذة الطباعة");
      return;
    }
    const esc = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
      );
    const subject = esc(message.subject || "(بدون موضوع)");
    const fromName = esc(message.from.name || message.from.email);
    const fromEmail = esc(message.from.email);
    const to = esc(message.to.map((t) => t.email).join(", "));
    const cc =
      message.cc && message.cc.length > 0 ? esc(message.cc.map((c) => c.email).join(", ")) : "";
    const date = esc(new Date(message.date).toLocaleString("ar"));
    const body = message.body || esc(message.preview);
    win.document
      .write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${subject}</title>
<style>
  body{font-family:'IBM Plex Sans Arabic',system-ui,sans-serif;color:#111;padding:24px;line-height:1.6}
  h1{font-size:20px;margin:0 0 16px}
  .meta{font-size:12px;color:#555;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:16px}
  .meta div{margin:2px 0}
  .body{font-size:14px}
  img{max-width:100%;height:auto}
  a{color:#0645ad;word-break:break-all}
</style></head><body>
<h1>${subject}</h1>
<div class="meta">
  <div><strong>المرسل:</strong> ${fromName} &lt;${fromEmail}&gt;</div>
  <div><strong>المستلم:</strong> <span dir="ltr">${to}</span></div>
  ${cc ? `<div><strong>نسخة:</strong> <span dir="ltr">${cc}</span></div>` : ""}
  <div><strong>التاريخ:</strong> ${date}</div>
</div>
<div class="body">${body}</div>
<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
</body></html>`);
    win.document.close();
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
          aria-label="رجوع"
        >
          <ChevronLeft className="h-4 w-4" /> رجوع
        </button>
        <div className="hidden gap-1 md:flex">
          <button onClick={onReply} className="rounded-lg p-2 hover:bg-muted" title="رد">
            <Reply className="h-4 w-4" />
          </button>
          <button
            onClick={onReplyAll}
            className="rounded-lg p-2 hover:bg-muted"
            title="رد على الكل"
          >
            <ReplyAll className="h-4 w-4" />
          </button>
          <button onClick={onForward} className="rounded-lg p-2 hover:bg-muted" title="إعادة توجيه">
            <Forward className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          {isTrash && (
            <button
              onClick={onRestore}
              className="rounded-lg p-2 hover:bg-muted"
              title="استعادة إلى المجلد الأصلي"
            >
              <ArchiveRestore className="h-4 w-4" />
            </button>
          )}
          <button onClick={onArchive} className="rounded-lg p-2 hover:bg-muted" title="أرشفة">
            <Archive className="h-4 w-4" />
          </button>
          <button onClick={onSpam} className="rounded-lg p-2 hover:bg-muted" title="مزعج">
            <AlertOctagon className="h-4 w-4" />
          </button>
          <button
            onClick={onMarkUnread}
            className="rounded-lg p-2 hover:bg-muted"
            title="تعليم كغير مقروءة"
          >
            <MailOpen className="h-4 w-4" />
          </button>
          <button onClick={printMessage} className="rounded-lg p-2 hover:bg-muted" title="طباعة">
            <Printer className="h-4 w-4" />
          </button>
          <button
            onClick={copyEmail}
            className="rounded-lg p-2 hover:bg-muted"
            title="نسخ عنوان المرسل"
          >
            <Copy className="h-4 w-4" />
          </button>
          <div className="mx-1 h-6 w-px bg-border" />
          <button
            onClick={onDelete}
            className="rounded-lg p-2 text-destructive hover:bg-destructive/10"
            title={isTrash ? "حذف نهائي" : "نقل إلى المهملات"}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded-lg p-2 hover:bg-muted" aria-label="خيارات أكثر">
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="w-56 [direction:rtl] [&_[role=menuitem]]:flex-row [&_[role=menuitem]]:justify-start [&_[role=menuitem]]:text-right"
          >
            <DropdownMenuItem onClick={onReply}>
              <Reply className="h-4 w-4" /> رد
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReplyAll}>
              <ReplyAll className="h-4 w-4" /> رد على الكل
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onForward}>
              <Forward className="h-4 w-4" /> إعادة توجيه
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onMarkUnread}>
              <MailOpen className="h-4 w-4" /> تعليم كغير مقروءة
            </DropdownMenuItem>
            <DropdownMenuItem onClick={printMessage}>
              <Printer className="h-4 w-4" /> طباعة
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copyEmail}>
              <Copy className="h-4 w-4" /> نسخ عنوان المرسل
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {isTrash && (
              <DropdownMenuItem onClick={onRestore}>
                <ArchiveRestore className="h-4 w-4" /> استعادة إلى المجلد الأصلي
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onArchive} className="md:hidden">
              <Archive className="h-4 w-4" /> أرشفة
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSpam} className="md:hidden">
              <AlertOctagon className="h-4 w-4" /> مزعج
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> {isTrash ? "حذف نهائي" : "نقل إلى المهملات"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl p-4 sm:p-6">
            <h1 className="break-words text-xl font-bold leading-snug sm:text-2xl">
              {message.subject || "(بدون موضوع)"}
            </h1>

            <div className="mt-4 flex items-start gap-3 border-b border-border pb-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white">
                {(message.from.name || message.from.email || "?").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold leading-tight">
                      {message.from.name || message.from.email || "(مرسل غير معروف)"}
                    </div>
                    {message.from.name && message.from.email && (
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={message.from.email}
                      >
                        <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                          {message.from.email}
                        </span>
                      </div>
                    )}
                  </div>
                  <span
                    className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                    title={new Date(message.date).toLocaleString("ar")}
                  >
                    {formatDate(message.date)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setDetailsOpen((v) => !v)}
                    aria-expanded={detailsOpen}
                    className="inline-flex max-w-full items-center gap-1 rounded hover:text-foreground"
                    title="تفاصيل الرسالة"
                  >
                    <span className="truncate">
                      <span className="text-foreground/70">إلى </span>
                      <span dir="ltr" className="unicode-bidi-isolate">
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
                        <dt className="text-foreground/70 whitespace-nowrap">المرسل:</dt>
                        <dd className="min-w-0 break-all">
                          {message.from.name ? (
                            <span className="ml-1">{message.from.name}</span>
                          ) : null}
                          <span dir="ltr" className="text-muted-foreground">
                            &lt;{message.from.email || "—"}&gt;
                          </span>
                        </dd>

                        <dt className="text-foreground/70 whitespace-nowrap">المستلم:</dt>
                        <dd className="min-w-0 break-all">
                          <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                            {message.to.length > 0
                              ? message.to.map((t) => t.email).join(", ")
                              : "—"}
                          </span>
                        </dd>

                        {message.cc && message.cc.length > 0 && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">نسخة:</dt>
                            <dd className="min-w-0 break-all">
                              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                                {message.cc.map((c) => c.email).join(", ")}
                              </span>
                            </dd>
                          </>
                        )}

                        <dt className="text-foreground/70 whitespace-nowrap">التاريخ:</dt>
                        <dd className="min-w-0">{fullDate}</dd>

                        {message.mailedBy && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">الخادم:</dt>
                            <dd className="min-w-0 break-all">
                              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                                {message.mailedBy}
                              </span>
                            </dd>
                          </>
                        )}
                        {message.signedBy && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">التوقيع:</dt>
                            <dd className="min-w-0 break-all">
                              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                                {message.signedBy}
                              </span>
                            </dd>
                          </>
                        )}
                        {message.security && (
                          <>
                            <dt className="text-foreground/70 whitespace-nowrap">الأمان:</dt>
                            <dd className="min-w-0 inline-flex items-center gap-1">
                              {isSecure ? (
                                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                              ) : (
                                <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                              )}
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

            <article
              className="prose prose-sm mt-6 max-w-none break-words text-foreground prose-a:text-brand-accent prose-img:rounded-lg"
              dangerouslySetInnerHTML={{ __html: message.body || message.preview }}
            />

            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-6">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">
                  المرفقات ({message.attachments.length})
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {message.attachments.map((a) => (
                    <AttachmentCard key={a.id} attachment={a} message={message} />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={onReply}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Reply className="h-4 w-4" /> رد
              </button>
              <button
                onClick={onReplyAll}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <ReplyAll className="h-4 w-4" /> رد على الكل
              </button>
              <button
                onClick={onForward}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Forward className="h-4 w-4" /> إعادة توجيه
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

function LoadingViewer({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden"
          aria-label="رجوع"
        >
          <ChevronLeft className="h-4 w-4" /> رجوع
        </button>
        <div />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    </>
  );
}

const COMPOSE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const COMPOSE_MAX_FILES = 10;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function Composer({
  session,
  initial,
  onClose,
  onSent,
}: {
  session: MailSession;
  initial?: ComposeInitial | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(initial?.to ?? "");
  const [cc, setCc] = useState(initial?.cc ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  function handlePickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const merged: File[] = [...files];
    let runningTotal = totalBytes;
    for (const f of incoming) {
      if (merged.length >= COMPOSE_MAX_FILES) {
        toast.error(`الحد الأقصى ${COMPOSE_MAX_FILES} ملفات`);
        break;
      }
      if (runningTotal + f.size > COMPOSE_MAX_TOTAL_BYTES) {
        toast.error(`تجاوزت الحد الكلّي (25MB)`);
        break;
      }
      merged.push(f);
      runningTotal += f.size;
    }
    setFiles(merged);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSend() {
    if (!to || !subject) return;
    setSending(true);
    setProgress(0);
    try {
      const parseAddresses = (raw: string) =>
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((email) => ({ name: "", email }));

      const payload = {
        account: session.account,
        password: session.password,
        to: parseAddresses(to),
        cc: parseAddresses(cc),
        bcc: [],
        subject,
        bodyHtml: body,
        bodyText: body,
      };

      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      for (const f of files) form.append("attachments", f, f.name);

      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/mail-send");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          try {
            const json = JSON.parse(xhr.responseText || "{}");
            if (xhr.status >= 200 && xhr.status < 300 && json.ok) resolve({ ok: true });
            else resolve({ ok: false, error: json.error || `HTTP ${xhr.status}` });
          } catch {
            resolve({ ok: false, error: `HTTP ${xhr.status}` });
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(form);
      });

      if (!result.ok) {
        toast.error(result.error || "فشل إرسال الرسالة");
        return;
      }
      toast.success("تم إرسال الرسالة");
      onClose();
      onSent();
    } catch (err: any) {
      toast.error(err?.message || "فشل إرسال الرسالة");
    } finally {
      setSending(false);
      setProgress(0);
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

        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-3">
            {files.map((f, i) => {
              const { Icon, tint } = getAttachmentIcon(f.type, f.name);
              return (
                <div
                  key={`${f.name}-${i}`}
                  className="group inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
                >
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${tint}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex flex-col leading-tight">
                    <span className="max-w-[160px] truncate font-medium">{f.name}</span>
                    <span className="text-[10px] text-muted-foreground">{formatBytes(f.size)}</span>
                  </div>
                  <button
                    onClick={() => removeFile(i)}
                    disabled={sending}
                    className="rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                    aria-label="حذف المرفق"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            <span className="self-center text-[11px] text-muted-foreground">
              {formatBytes(totalBytes)} / 25 MB
            </span>
          </div>
        )}

        {sending && progress > 0 && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-brand-gradient transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
        <button
          onClick={handleSend}
          disabled={sending || !to || !subject}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sending ? (progress > 0 ? `جاري الإرسال ${progress}%` : "جاري الإرسال") : "إرسال"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handlePickFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending || files.length >= COMPOSE_MAX_FILES}
          className="rounded-md p-2 hover:bg-muted disabled:opacity-40"
          aria-label="إرفاق ملف"
          title="إرفاق ملف"
        >
          <Paperclip className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---- Attachment card with download + inline preview ----
const INLINE_PREVIEW_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function getAttachmentIcon(
  mimeType: string,
  filename: string,
): {
  Icon: typeof Paperclip;
  tint: string;
} {
  const mime = (mimeType || "").toLowerCase();
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (mime.startsWith("image/"))
    return { Icon: FileImage, tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
  if (mime.startsWith("video/"))
    return { Icon: FileVideo, tint: "bg-purple-500/10 text-purple-600 dark:text-purple-400" };
  if (mime.startsWith("audio/"))
    return { Icon: FileAudio, tint: "bg-pink-500/10 text-pink-600 dark:text-pink-400" };
  if (mime === "application/pdf" || ext === "pdf")
    return { Icon: FileType, tint: "bg-red-500/10 text-red-600 dark:text-red-400" };
  if (
    /zip|rar|7z|tar|gzip|compressed/.test(mime) ||
    ["zip", "rar", "7z", "tar", "gz"].includes(ext)
  )
    return { Icon: FileArchive, tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
  if (/sheet|excel|csv/.test(mime) || ["xls", "xlsx", "csv", "ods"].includes(ext))
    return { Icon: FileSpreadsheet, tint: "bg-green-500/10 text-green-600 dark:text-green-400" };
  if (/word|document|opendocument\.text/.test(mime) || ["doc", "docx", "odt", "rtf"].includes(ext))
    return { Icon: FileText, tint: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
  if (/presentation|powerpoint/.test(mime) || ["ppt", "pptx", "odp", "key"].includes(ext))
    return { Icon: FileType, tint: "bg-orange-500/10 text-orange-600 dark:text-orange-400" };
  if (
    /json|xml|javascript|typescript|html|css|x-sh|x-python/.test(mime) ||
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "json",
      "xml",
      "html",
      "css",
      "py",
      "sh",
      "java",
      "c",
      "cpp",
      "go",
      "rs",
    ].includes(ext)
  )
    return { Icon: FileCode, tint: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" };
  if (mime.startsWith("text/") || ["txt", "md", "log"].includes(ext))
    return { Icon: FileText, tint: "bg-slate-500/10 text-slate-600 dark:text-slate-400" };

  return { Icon: Paperclip, tint: "bg-brand-gradient/10 text-brand-accent" };
}

function AttachmentCard({
  attachment,
  message,
}: {
  attachment: import("@/lib/mail-types").MailAttachment;
  message: MailMessage;
}) {
  const [busy, setBusy] = useState<"download" | "preview" | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const canPreview = INLINE_PREVIEW_MIME.has((attachment.mimeType || "").toLowerCase());
  const canDownload = !!attachment.part;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function fetchBlob(): Promise<Blob | null> {
    const session = getMailSession();
    if (!session) {
      toast.error("انتهت الجلسة");
      return null;
    }
    const parsed = parseMessageId(message.id);
    if (!parsed || !attachment.part) {
      toast.error("لا يمكن تحديد المرفق");
      return null;
    }
    const res = await fetch("/api/mail-attachment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: session.account,
        password: session.password,
        folder: parsed.folder,
        uid: parsed.uid,
        part: attachment.part,
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      toast.error(`تعذّر تنزيل المرفق${msg ? `: ${msg.slice(0, 100)}` : ""}`);
      return null;
    }
    return await res.blob();
  }

  async function handleDownload() {
    if (busy || !canDownload) return;
    setBusy("download");
    try {
      const blob = await fetchBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename || "attachment";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } finally {
      setBusy(null);
    }
  }

  async function handlePreview() {
    if (busy || !canDownload || !canPreview) return;
    setBusy("preview");
    try {
      const blob = await fetchBlob();
      if (!blob) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } finally {
      setBusy(null);
    }
  }

  const { Icon: FileIcon, tint } = getAttachmentIcon(attachment.mimeType, attachment.filename);

  return (
    <>
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2.5 sm:gap-3 sm:p-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 ${tint}`}
        >
          <FileIcon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="line-clamp-2 break-all text-[13px] font-medium leading-snug sm:text-sm"
            title={attachment.filename}
          >
            {attachment.filename}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground sm:text-xs">
            <bdi dir="ltr">{formatSize(attachment.size)}</bdi>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canPreview && (
            <button
              type="button"
              onClick={handlePreview}
              disabled={!canDownload || busy !== null}
              title="معاينة"
              aria-label="معاينة"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8"
            >
              {busy === "preview" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={!canDownload || busy !== null}
            title={canDownload ? "تنزيل" : "غير متاح"}
            aria-label="تنزيل"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8"
          >
            {busy === "download" ? (
              <CircleArrowDown className="h-4 w-4 animate-bounce text-primary" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-white">
            <p className="truncate text-sm font-medium">{attachment.filename}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20"
              >
                <Download className="h-3.5 w-3.5" /> تنزيل
              </button>
              <button
                type="button"
                onClick={() => setPreviewUrl(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/10 hover:bg-white/20"
                title="إغلاق"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div
            className="flex flex-1 items-center justify-center overflow-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {attachment.mimeType.startsWith("image/") ? (
              <img
                src={previewUrl}
                alt={attachment.filename}
                className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
              />
            ) : (
              <iframe
                src={previewUrl}
                title={attachment.filename}
                className="h-full w-full rounded-lg bg-white shadow-2xl"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
