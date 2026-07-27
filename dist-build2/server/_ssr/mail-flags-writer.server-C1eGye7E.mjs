//#region node_modules/.nitro/vite/services/ssr/assets/mail-flags-writer.server-C1eGye7E.js
/** Resolve a folder row by (account_id, company_id, canonical). Returns null
*  when the folder has not been indexed yet or has no uidvalidity assigned. */
async function resolveFolderForFlag(supabase, accountId, companyId, canonical) {
	const q = await supabase.from("mail_folders").select("id, uidvalidity").eq("account_id", accountId).eq("company_id", companyId).eq("canonical", canonical).maybeSingle();
	if (q.error) throw q.error;
	if (!q.data?.id || q.data.uidvalidity == null) return null;
	return {
		id: q.data.id,
		uidvalidity: Number(q.data.uidvalidity)
	};
}
/** Apply a single-message flag change scoped by (account, folder, uidvalidity,
*  uid). Company scoping is enforced by the caller via `resolveFolderForFlag`. */
async function updateMessageFlag(supabase, params) {
	const patch = {};
	if (params.kind === "seen") patch.seen = params.value;
	else patch.flagged = params.value;
	const up = await supabase.from("mail_messages").update(patch).eq("account_id", params.accountId).eq("folder_id", params.folderId).eq("uidvalidity", params.uidvalidity).eq("uid", params.uid);
	if (up.error) throw up.error;
}
/** Recompute the folder's unread count via a head-only count query and write
*  it back to `mail_folders.unread`. Cheap: PostgREST head+count avoids row
*  materialization. Called only when a `seen` flag changes. */
async function recomputeFolderUnread(supabase, params) {
	const q = await supabase.from("mail_messages").select("*", {
		count: "exact",
		head: true
	}).eq("account_id", params.accountId).eq("folder_id", params.folderId).eq("uidvalidity", params.uidvalidity).is("deleted_at", null).eq("seen", false);
	if (q.error) throw q.error;
	const unread = q.count ?? 0;
	const up = await supabase.from("mail_folders").update({ unread }).eq("id", params.folderId);
	if (up.error) throw up.error;
	return unread;
}
/** Mark a folder as needing flag reconcile. Used when IMAP succeeded but the
*  local index write failed — the next scheduled reconcile will re-apply
*  IMAP truth so we never roll back the optimistic UI. */
async function markFolderNeedsFlagReconcile(supabase, params) {
	const up = await supabase.from("mail_sync_state").update({ flags_need_reconcile: true }).eq("account_id", params.accountId).eq("folder_id", params.folderId);
	if (up.error) throw up.error;
}
//#endregion
export { markFolderNeedsFlagReconcile, recomputeFolderUnread, resolveFolderForFlag, updateMessageFlag };
