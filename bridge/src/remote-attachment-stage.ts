/**
 * Only private object-storage URLs minted by the app server may be fetched by
 * the Bridge. Keeping this allow-list separate makes the SSRF boundary easy
 * to audit and test. Custom storage hosts can be added explicitly in
 * MAIL_REMOTE_ATTACHMENT_HOSTS (comma-separated).
 */
export function isAllowedRemoteAttachmentUrl(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.port && url.port !== "443") return false;
    const host = url.hostname.toLowerCase();
    const configured = String(env.MAIL_REMOTE_ATTACHMENT_HOSTS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return host.endsWith(".supabase.co") || configured.includes(host);
  } catch {
    return false;
  }
}
