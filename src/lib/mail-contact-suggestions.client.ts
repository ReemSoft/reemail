// Browser-side address-book cache. Persists per (companyId, mailboxAccountId)
// in IndexedDB, hydrates from the server once per session, then serves all
// autocomplete queries locally without any network hops during typing.
//
// The server is only touched at three points:
//   * hydrate on Composer mount
//   * record after a successful SMTP send
//   * hide when the user removes a suggestion
//
// If the network is unavailable or any of those calls fail, sending must
// still succeed and existing local suggestions must still work.
import type { ContactSuggestion } from "@/lib/mail-contact-suggestions.functions";

const DB_NAME = "mailmaestro.contacts";
const DB_VERSION = 1;
const STORE = "suggestions";

export interface StoredSuggestion {
  scopeKey: string; // `${companyId}:${accountId}`
  email: string;
  name: string | null;
  frequency: number;
  lastUsedAt: number; // unix ms
}

function scopeKeyFor(companyId: string, accountId: string): string {
  return `${companyId}:${accountId}`;
}

// ---------- IndexedDB helpers (fail-safe: never throw upstream) ----------

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, {
            keyPath: ["scopeKey", "email"],
          });
          store.createIndex("byScope", "scopeKey", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      let out: T | null = null;
      Promise.resolve(fn(s))
        .then((v) => {
          out = v as T;
        })
        .catch(() => {
          out = null;
        });
      t.oncomplete = () => resolve(out);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function req<T>(r: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}

// ---------- In-memory ranked cache (rebuilt after any mutation) ----------

interface RankedRow {
  email: string;
  name: string | null;
  frequency: number;
  lastUsedAt: number;
  tokens: string[]; // lowercased tokens from email local-part + name
  emailLower: string;
  nameLower: string;
}

interface CacheEntry {
  scopeKey: string;
  rows: RankedRow[];
  loaded: boolean;
  loadingPromise: Promise<void> | null;
}

const memCache = new Map<string, CacheEntry>();

function tokenize(email: string, name: string | null): string[] {
  const local = email.split("@")[0] ?? "";
  const parts = new Set<string>();
  for (const t of local.split(/[.\-_+]+/).filter(Boolean)) parts.add(t.toLowerCase());
  if (name) {
    for (const t of name.split(/\s+/).filter(Boolean)) parts.add(t.toLowerCase());
  }
  return Array.from(parts);
}

function toRanked(s: StoredSuggestion): RankedRow {
  return {
    email: s.email,
    name: s.name,
    frequency: s.frequency,
    lastUsedAt: s.lastUsedAt,
    tokens: tokenize(s.email, s.name),
    emailLower: s.email.toLowerCase(),
    nameLower: (s.name ?? "").toLowerCase(),
  };
}

function ensureEntry(scopeKey: string): CacheEntry {
  let e = memCache.get(scopeKey);
  if (!e) {
    e = { scopeKey, rows: [], loaded: false, loadingPromise: null };
    memCache.set(scopeKey, e);
  }
  return e;
}

async function loadLocalIntoMem(scopeKey: string): Promise<void> {
  const entry = ensureEntry(scopeKey);
  const list = await tx<StoredSuggestion[]>("readonly", async (s) => {
    const idx = s.index("byScope");
    const out = await req(idx.getAll(IDBKeyRange.only(scopeKey)));
    return (out as StoredSuggestion[] | null) ?? [];
  });
  entry.rows = (list ?? []).map(toRanked);
  entry.loaded = true;
}

// ---------- Public API ----------

/**
 * Ensure the local cache for this scope is populated. Reads IndexedDB first,
 * then fires a background server hydrate that merges the freshest 500
 * suggestions on top. Idempotent; safe to call from React effects.
 */
export function ensureScopeReady(
  companyId: string,
  accountId: string,
  hydrateFromServer: () => Promise<ContactSuggestion[] | null>,
): Promise<void> {
  const scopeKey = scopeKeyFor(companyId, accountId);
  const entry = ensureEntry(scopeKey);
  if (entry.loadingPromise) return entry.loadingPromise;
  entry.loadingPromise = (async () => {
    await loadLocalIntoMem(scopeKey);
    try {
      const remote = await hydrateFromServer();
      if (remote && remote.length > 0) {
        await mergeFromServer(scopeKey, remote);
      }
    } catch {
      /* offline / auth expired — keep local rows */
    }
  })();
  return entry.loadingPromise;
}

async function mergeFromServer(scopeKey: string, remote: ContactSuggestion[]) {
  // Server is authoritative. Overwrite the scope wholesale with the freshest
  // 500 non-hidden suggestions, then rebuild the in-mem cache.
  await tx("readwrite", async (s) => {
    // Delete existing scope rows
    const idx = s.index("byScope");
    const keys = await req(idx.getAllKeys(IDBKeyRange.only(scopeKey)));
    for (const k of (keys as IDBValidKey[] | null) ?? []) {
      s.delete(k);
    }
    for (const r of remote) {
      const row: StoredSuggestion = {
        scopeKey,
        email: r.email,
        name: r.name,
        frequency: r.frequency,
        lastUsedAt: r.lastUsedAt,
      };
      s.put(row);
    }
  });
  const entry = ensureEntry(scopeKey);
  entry.rows = remote.map((r) => toRanked({ scopeKey, ...r }));
  entry.loaded = true;
}

export interface AutocompleteMatch {
  email: string;
  name: string | null;
  frequency: number;
  lastUsedAt: number;
}

/**
 * Purely local prefix/substring search. Zero network. Returns up to `limit`
 * ranked matches (prefix > token > substring, tie-broken by frequency + recency).
 * Emails passed in `exclude` are skipped (already-chosen chips).
 */
export function searchLocal(
  companyId: string,
  accountId: string,
  query: string,
  opts?: { limit?: number; exclude?: Iterable<string> },
): AutocompleteMatch[] {
  const scopeKey = scopeKeyFor(companyId, accountId);
  const entry = memCache.get(scopeKey);
  if (!entry || !entry.loaded) return [];
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts?.limit ?? 8, 25));
  const excluded = new Set<string>();
  if (opts?.exclude) for (const e of opts.exclude) excluded.add(e.toLowerCase());

  type Scored = { row: RankedRow; score: number };
  const out: Scored[] = [];
  for (const row of entry.rows) {
    if (excluded.has(row.emailLower)) continue;
    let score = 0;
    if (row.emailLower.startsWith(q)) score = 1000;
    else if (row.nameLower && row.nameLower.startsWith(q)) score = 900;
    else if (row.tokens.some((t) => t.startsWith(q))) score = 800;
    else if (row.emailLower.includes(q) || row.nameLower.includes(q)) score = 500;
    else continue;
    // Frequency + recency signal (bounded)
    score += Math.min(row.frequency, 50) * 2;
    score += Math.max(0, 30 - Math.floor((Date.now() - row.lastUsedAt) / (86400 * 1000)));
    out.push({ row, score });
  }
  out.sort((a, b) => b.score - a.score || b.row.lastUsedAt - a.row.lastUsedAt);
  return out.slice(0, limit).map(({ row }) => ({
    email: row.email,
    name: row.name,
    frequency: row.frequency,
    lastUsedAt: row.lastUsedAt,
  }));
}

/**
 * Local optimistic bump after a successful send. The server RPC is the
 * source of truth for `frequency`; this only keeps the UI fresh until the
 * next hydrate.
 */
export async function recordLocalSend(
  companyId: string,
  accountId: string,
  recipients: Array<{ email: string; name?: string | null }>,
): Promise<void> {
  const scopeKey = scopeKeyFor(companyId, accountId);
  const entry = ensureEntry(scopeKey);
  const now = Date.now();
  const byEmail = new Map(entry.rows.map((r) => [r.emailLower, r]));
  const toPersist: StoredSuggestion[] = [];
  for (const r of recipients) {
    const email = (r.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const existing = byEmail.get(email);
    const name = (r.name ?? "").trim() || existing?.name || null;
    const merged: StoredSuggestion = {
      scopeKey,
      email,
      name,
      frequency: (existing?.frequency ?? 0) + 1,
      lastUsedAt: now,
    };
    toPersist.push(merged);
    const ranked = toRanked(merged);
    if (existing) {
      Object.assign(existing, ranked);
    } else {
      entry.rows.push(ranked);
    }
  }
  if (toPersist.length === 0) return;
  await tx("readwrite", (s) => {
    for (const row of toPersist) s.put(row);
  });
}

/** Remove locally & permanently from the current scope's cache. */
export async function forgetLocal(
  companyId: string,
  accountId: string,
  email: string,
): Promise<void> {
  const scopeKey = scopeKeyFor(companyId, accountId);
  const norm = email.trim().toLowerCase();
  const entry = memCache.get(scopeKey);
  if (entry) entry.rows = entry.rows.filter((r) => r.emailLower !== norm);
  await tx("readwrite", (s) => {
    s.delete([scopeKey, norm]);
  });
}

/**
 * Clear the in-memory cache immediately. Called on sign-out or account
 * switch so a previous scope's suggestions never leak into a new session's
 * UI on the same browser.
 */
export function clearMemoryCache() {
  memCache.clear();
}

/** Wipe every scope from IndexedDB. Used on hard sign-out. */
export async function wipeAllPersisted(): Promise<void> {
  clearMemoryCache();
  await tx("readwrite", (s) => {
    s.clear();
  });
}
