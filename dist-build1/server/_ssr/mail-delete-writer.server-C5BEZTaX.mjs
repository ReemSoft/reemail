import { resolveFolderByCanonical, tombstoneSourceRow } from "./mail-move-writer.server-BchvkBzO.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-delete-writer.server-C5BEZTaX.js
async function applyDeleteWriteThrough(supabase, input) {
	const src = await resolveFolderByCanonical(supabase, input.accountId, input.companyId, input.sourceCanonical);
	if (!src || src.uidvalidity == null) return {
		ok: true,
		applied: "no-source-folder",
		wasUnread: false
	};
	const tomb = await tombstoneSourceRow(supabase, {
		accountId: input.accountId,
		folderId: src.id,
		uidvalidity: src.uidvalidity,
		uid: input.sourceUid
	});
	if (!tomb.changed) return {
		ok: true,
		applied: "already-tombstoned",
		wasUnread: false
	};
	const rpc = await supabase.rpc("adjust_mail_folder_counts_atomic", {
		p_folder_id: src.id,
		p_account_id: input.accountId,
		p_company_id: input.companyId,
		p_total_delta: -1,
		p_unread_delta: tomb.wasUnread ? -1 : 0
	});
	if (rpc.error) return {
		ok: false,
		error: rpc.error.message
	};
	return {
		ok: true,
		applied: "tombstoned",
		wasUnread: tomb.wasUnread
	};
}
//#endregion
export { applyDeleteWriteThrough };
