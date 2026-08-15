/**
 * Signature storage (browser only).
 *
 * One row per authenticated user in `mail_signatures`, guarded by RLS. The
 * value is fetched LAZILY (first time the composer needs it) and then kept in
 * a module-level cache for the rest of the tab session, so opening the app,
 * opening a message, or opening the composer again costs zero extra requests.
 */
import { supabase } from "@/integrations/supabase/client";
import { sanitizeSignatureHtml } from "./mail-signature";

let cache: string | null = null;
let inflight: Promise<string> | null = null;

/** Cached signature HTML, or null when it has not been loaded yet. */
export function peekSignature(): string | null {
  return cache;
}

export async function loadSignature(): Promise<string> {
  if (cache !== null) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const { data, error } = await supabase
      .from("mail_signatures")
      .select("html")
      .maybeSingle();
    if (error) throw error;
    cache = sanitizeSignatureHtml(data?.html ?? "");
    return cache;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function saveSignature(html: string): Promise<string> {
  const clean = sanitizeSignatureHtml(html);
  // The browser client already carries the authenticated session used by RLS.
  // Avoid a second Auth API round-trip here: it can fail independently while
  // the valid Data API session is still active, preventing an otherwise valid
  // save. The database policy remains the authoritative ownership check.
  const { data: auth, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const userId = auth.session?.user.id;
  if (!userId) throw new Error("NOT_AUTHENTICATED");
  const { error } = await supabase
    .from("mail_signatures")
    .upsert({ user_id: userId, html: clean }, { onConflict: "user_id" });
  if (error) throw error;
  cache = clean;
  return clean;
}
