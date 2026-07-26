// Runtime feature flag for the Local Mail Index consumer path.
// Toggle without redeploying by setting VITE_MAIL_INDEX_ENABLED=false.
// Defaults to true so new users get the fast index-first read.
export const MAIL_INDEX_ENABLED: boolean =
  (import.meta.env.VITE_MAIL_INDEX_ENABLED ?? "true") !== "false";

/** Which canonical folders may read from the Local Mail Index.
 *  All standard folders are enabled now that the bridge returns real IMAP
 *  paths on FolderCount and sync uses that path directly. Custom folders
 *  (canonical=null) are handled by the sync writer but are not enumerated
 *  here. */
export const INDEXED_FOLDERS = new Set<string>([
  "inbox",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
]);
