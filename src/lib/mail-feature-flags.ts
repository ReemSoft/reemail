// Runtime feature flag for the Local Mail Index consumer path.
// Toggle without redeploying by setting VITE_MAIL_INDEX_ENABLED=false.
// Defaults to true so new users get the fast index-first read.
export const MAIL_INDEX_ENABLED: boolean =
  (import.meta.env.VITE_MAIL_INDEX_ENABLED ?? "true") !== "false";

/** Which canonical folders read from the Local Mail Index in Pass B.
 *  Only "inbox" is enabled initially because the sync writer's folder-path
 *  resolution is currently hard-coded to "INBOX"; other folders continue
 *  through the direct IMAP bridge until path resolution ships. */
export const INDEXED_FOLDERS = new Set<string>(["inbox"]);
