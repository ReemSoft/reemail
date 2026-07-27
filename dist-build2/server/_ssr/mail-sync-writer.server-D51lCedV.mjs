//#region node_modules/.nitro/vite/services/ssr/assets/mail-sync-writer.server-D51lCedV.js
/**
* True iff the mailbox's UIDVALIDITY differs from the value we already stored
* for this folder. First-time sync (`stored == null`) is NOT a wipe — it's
* the initial adoption of the value.
*/
function shouldWipeForUidValidity(stored, incoming) {
	if (stored == null) return false;
	return String(stored) !== String(incoming);
}
/**
* Given the set of UIDs currently present on the server within [fromUid,toUid]
* and the set of UIDs we already have locally in the same range, return the
* UIDs to tombstone (present locally, missing on server).
*/
function computeTombstoneUids(localUids, presentUids) {
	const present = /* @__PURE__ */ new Set();
	for (const u of presentUids) present.add(u);
	const out = [];
	for (const u of localUids) if (!present.has(u)) out.push(u);
	return out;
}
function mapSyncMessageToRow(args, m) {
	return {
		account_id: args.accountId,
		company_id: args.companyId,
		folder_id: args.folderId,
		uid: m.uid,
		uidvalidity: Number(args.uidValidity),
		modseq: m.modseq == null ? null : Number(m.modseq),
		message_id: m.messageId,
		in_reply_to: m.inReplyTo,
		subject: m.subject && m.subject.length ? m.subject : null,
		from_addr: m.from,
		to_addrs: m.to,
		cc_addrs: m.cc,
		internal_date: m.internalDate,
		size_bytes: m.sizeBytes,
		has_attachments: m.hasAttachments,
		seen: m.flagSeen,
		flagged: m.flagFlagged,
		answered: m.flagAnswered,
		draft: m.flagDraft,
		keywords: m.keywords,
		deleted_at: null
	};
}
function mapFlagStateToUpdate(s) {
	return {
		modseq: s.modseq == null ? null : Number(s.modseq),
		seen: s.flagSeen,
		flagged: s.flagFlagged,
		answered: s.flagAnswered,
		draft: s.flagDraft,
		keywords: s.keywords
	};
}
/**
* Get or create the folder row for (account_id, path). Returns the folder id
* plus the currently-stored uidvalidity (if any) so callers can detect a
* UIDVALIDITY reset without a second round-trip.
*/
async function ensureFolderRow(admin, args) {
	const sel = await admin.from("mail_folders").select("id, uidvalidity").eq("account_id", args.accountId).eq("path", args.path).maybeSingle();
	if (sel.error) throw sel.error;
	if (sel.data?.id) return {
		folderId: sel.data.id,
		storedUidValidity: sel.data.uidvalidity != null ? String(sel.data.uidvalidity) : null
	};
	const ins = await admin.from("mail_folders").insert({
		account_id: args.accountId,
		company_id: args.companyId,
		path: args.path,
		canonical: args.canonical ?? null,
		delimiter: args.delimiter ?? null,
		supported: args.supported ?? true
	}).select("id, uidvalidity").maybeSingle();
	if (ins.error) {
		if (ins.error.code === "23505") {
			const again = await admin.from("mail_folders").select("id, uidvalidity").eq("account_id", args.accountId).eq("path", args.path).maybeSingle();
			if (again.data?.id) return {
				folderId: again.data.id,
				storedUidValidity: again.data.uidvalidity != null ? String(again.data.uidvalidity) : null
			};
		}
		throw ins.error;
	}
	if (!ins.data?.id) throw new Error("FOLDER_UPSERT_FAILED");
	return {
		folderId: ins.data.id,
		storedUidValidity: ins.data.uidvalidity != null ? String(ins.data.uidvalidity) : null
	};
}
/**
* Wipe all local rows for a folder when UIDVALIDITY changed. The folder row
* itself is retained; sync_state cursors are reset so the next call behaves
* like a fresh initial sync.
*/
async function wipeFolderForUidValidityReset(admin, args) {
	const del = await admin.from("mail_messages").delete().eq("account_id", args.accountId).eq("folder_id", args.folderId);
	if (del.error) throw del.error;
	const stateUp = await admin.from("mail_sync_state").update({
		uidvalidity: Number(args.newUidValidity),
		oldest_synced_uid: null,
		newest_synced_uid: null,
		highest_modseq: null,
		uidnext: null,
		flags_need_reconcile: false,
		last_reconcile_at: null
	}).eq("account_id", args.accountId).eq("folder_id", args.folderId);
	if (stateUp.error) throw stateUp.error;
	const folderUp = await admin.from("mail_folders").update({ uidvalidity: Number(args.newUidValidity) }).eq("id", args.folderId);
	if (folderUp.error) throw folderUp.error;
}
/**
* Upsert message metadata rows in bounded batches so a single sync round
* never issues a huge single statement. Conflicts on
* (account_id, folder_id, uidvalidity, uid) update in place.
*/
async function upsertMessagesInBatches(admin, args, messages) {
	if (messages.length === 0) return 0;
	let wrote = 0;
	for (let i = 0; i < messages.length; i += 200) {
		const chunk = messages.slice(i, i + 200).map((m) => mapSyncMessageToRow(args, m));
		const { error } = await admin.from("mail_messages").upsert(chunk, { onConflict: "account_id,folder_id,uidvalidity,uid" });
		if (error) throw error;
		wrote += chunk.length;
	}
	return wrote;
}
/**
* Apply CONDSTORE flag deltas. Only the flag columns are touched; envelope
* data is left untouched.
*/
async function applyFlagStates(admin, args, states) {
	if (states.length === 0) return 0;
	const uv = Number(args.uidValidity);
	let updated = 0;
	for (const s of states) {
		const patch = mapFlagStateToUpdate(s);
		const { error, count } = await admin.from("mail_messages").update(patch, { count: "exact" }).eq("account_id", args.accountId).eq("folder_id", args.folderId).eq("uidvalidity", uv).eq("uid", s.uid);
		if (error) throw error;
		updated += count ?? 0;
	}
	return updated;
}
/**
* Reconcile a UID range: rows that exist locally but not in `presentUids`
* are soft-deleted (tombstoned). Returns the number of tombstoned rows.
*/
async function tombstoneMissingInRange(admin, args) {
	const uv = Number(args.uidValidity);
	const sel = await admin.from("mail_messages").select("uid").eq("account_id", args.accountId).eq("folder_id", args.folderId).eq("uidvalidity", uv).gte("uid", args.fromUid).lte("uid", args.toUid).is("deleted_at", null);
	if (sel.error) throw sel.error;
	const missing = computeTombstoneUids((sel.data ?? []).map((r) => Number(r.uid)), args.presentUids);
	if (missing.length === 0) return 0;
	const nowIso = (/* @__PURE__ */ new Date()).toISOString();
	let tombstoned = 0;
	for (let i = 0; i < missing.length; i += 200) {
		const chunk = missing.slice(i, i + 200);
		const { error } = await admin.from("mail_messages").update({ deleted_at: nowIso }).eq("account_id", args.accountId).eq("folder_id", args.folderId).eq("uidvalidity", uv).in("uid", chunk);
		if (error) throw error;
		tombstoned += chunk.length;
	}
	return tombstoned;
}
/** Recompute total/unread from live rows and write them to mail_folders. */
async function refreshFolderCounts(admin, args) {
	const uv = Number(args.uidValidity);
	const unreadQ = admin.from("mail_messages").select("*", {
		count: "exact",
		head: true
	}).eq("account_id", args.accountId).eq("folder_id", args.folderId).eq("uidvalidity", uv).is("deleted_at", null).eq("seen", false);
	const hasAuthoritative = args.authoritativeTotal != null && Number.isFinite(args.authoritativeTotal) && args.authoritativeTotal >= 0;
	let total;
	if (hasAuthoritative) {
		total = Math.trunc(args.authoritativeTotal);
		const u = await unreadQ;
		if (u.error) throw u.error;
		const unread = Math.min(u.count ?? 0, total);
		const up = await admin.from("mail_folders").update({
			total,
			unread
		}).eq("id", args.folderId);
		if (up.error) throw up.error;
		return {
			total,
			unread
		};
	}
	const totalQ = admin.from("mail_messages").select("*", {
		count: "exact",
		head: true
	}).eq("account_id", args.accountId).eq("folder_id", args.folderId).eq("uidvalidity", uv).is("deleted_at", null);
	const [t, u] = await Promise.all([totalQ, unreadQ]);
	if (t.error) throw t.error;
	if (u.error) throw u.error;
	total = t.count ?? 0;
	const unread = u.count ?? 0;
	const up = await admin.from("mail_folders").update({
		total,
		unread
	}).eq("id", args.folderId);
	if (up.error) throw up.error;
	return {
		total,
		unread
	};
}
/** Persist the freshest mailbox-level state onto the folder row. */
async function writeFolderMailboxState(admin, folderId, mb) {
	const up = await admin.from("mail_folders").update({
		uidvalidity: mb.uidValidity ? Number(mb.uidValidity) : null,
		uidnext: mb.uidNext,
		highest_modseq: mb.highestModseq == null ? null : Number(mb.highestModseq),
		last_synced_at: (/* @__PURE__ */ new Date()).toISOString()
	}).eq("id", folderId);
	if (up.error) throw up.error;
}
/** Update the sync-state cursor after a successful (partial) sync. */
async function updateSyncCursor(admin, args) {
	const patch = {
		uidvalidity: Number(args.uidValidity),
		uidnext: args.uidNext,
		highest_modseq: args.highestModseq == null ? null : Number(args.highestModseq)
	};
	if (args.oldestSyncedUid != null) patch.oldest_synced_uid = args.oldestSyncedUid;
	if (args.newestSyncedUid != null) patch.newest_synced_uid = args.newestSyncedUid;
	if (args.flagsNeedReconcile != null) patch.flags_need_reconcile = args.flagsNeedReconcile;
	if (args.markReconciledAt) patch.last_reconcile_at = (/* @__PURE__ */ new Date()).toISOString();
	const up = await admin.from("mail_sync_state").update(patch).eq("account_id", args.accountId).eq("folder_id", args.folderId);
	if (up.error) throw up.error;
}
/** Read the current sync cursor (may be null if the row was just created). */
async function readSyncCursor(admin, args) {
	const { data, error } = await admin.from("mail_sync_state").select("uidvalidity, uidnext, highest_modseq, oldest_synced_uid, newest_synced_uid, flags_need_reconcile").eq("account_id", args.accountId).eq("folder_id", args.folderId).maybeSingle();
	if (error) throw error;
	if (!data) return null;
	return {
		uidvalidity: data.uidvalidity != null ? String(data.uidvalidity) : null,
		uidnext: data.uidnext,
		highest_modseq: data.highest_modseq != null ? String(data.highest_modseq) : null,
		oldest_synced_uid: data.oldest_synced_uid,
		newest_synced_uid: data.newest_synced_uid,
		flags_need_reconcile: !!data.flags_need_reconcile
	};
}
async function claimSyncLock(admin, args) {
	const { data, error } = await admin.rpc("claim_mail_sync_lock", {
		p_account_id: args.accountId,
		p_company_id: args.companyId,
		p_folder_id: args.folderId,
		p_locked_by: args.lockedBy,
		p_ttl_seconds: args.ttlSeconds
	});
	if (error) throw error;
	return !!data;
}
async function releaseSyncLock(admin, args) {
	const { data, error } = await admin.rpc("release_mail_sync_lock", {
		p_account_id: args.accountId,
		p_company_id: args.companyId,
		p_folder_id: args.folderId,
		p_locked_by: args.lockedBy,
		p_status: args.status,
		p_error_code: args.errorCode ?? void 0,
		p_error_msg: args.errorMessage ?? void 0
	});
	if (error) throw error;
	return !!data;
}
//#endregion
export { applyFlagStates, claimSyncLock, ensureFolderRow, readSyncCursor, refreshFolderCounts, releaseSyncLock, shouldWipeForUidValidity, tombstoneMissingInRange, updateSyncCursor, upsertMessagesInBatches, wipeFolderForUidValidityReset, writeFolderMailboxState };
