//#region node_modules/.nitro/vite/services/ssr/assets/mail-move-writer.server-BchvkBzO.js
/** Starred is a virtual view over INBOX; the physical mail_folders row is INBOX. */
function normalizeCanonicalForIndex(canonical) {
	return canonical === "starred" ? "inbox" : canonical;
}
async function resolveFolderByCanonical(supabase, accountId, companyId, canonical) {
	const q = await supabase.from("mail_folders").select("id, uidvalidity, path").eq("account_id", accountId).eq("company_id", companyId).eq("canonical", normalizeCanonicalForIndex(canonical)).maybeSingle();
	if (q.error) throw q.error;
	if (!q.data?.id) return null;
	return {
		id: q.data.id,
		uidvalidity: q.data.uidvalidity == null ? null : Number(q.data.uidvalidity),
		path: q.data.path ?? null
	};
}
async function resolveFolderByPath(supabase, accountId, path, companyId) {
	let q = supabase.from("mail_folders").select("id, uidvalidity, path").eq("account_id", accountId).eq("path", path);
	if (companyId) q = q.eq("company_id", companyId);
	const res = await q.maybeSingle();
	if (res.error) throw res.error;
	if (!res.data?.id) return null;
	return {
		id: res.data.id,
		uidvalidity: res.data.uidvalidity == null ? null : Number(res.data.uidvalidity),
		path: res.data.path ?? null
	};
}
/**
* Snapshot the identity of a locally-indexed row BEFORE a Move so we can
* later find its new UID at the destination without trusting Bridge-provided
* UIDs (many servers don't return UIDPLUS COPYUID). Returns null when the
* row is missing — the caller must degrade gracefully in that case.
*/
async function captureSourceFingerprint(supabase, params) {
	const q = await supabase.from("mail_messages").select("message_id, internal_date, size_bytes, subject, from_addr").eq("account_id", params.accountId).eq("folder_id", params.folderId).eq("uidvalidity", params.uidvalidity).eq("uid", params.uid).maybeSingle();
	if (q.error) throw q.error;
	if (!q.data) return null;
	const from = q.data.from_addr;
	const fromEmail = from && typeof from === "object" && typeof from.email === "string" ? from.email.toLowerCase() : null;
	return {
		messageId: q.data.message_id ?? null,
		internalDate: q.data.internal_date ?? null,
		sizeBytes: q.data.size_bytes ?? null,
		subject: q.data.subject ?? null,
		fromEmail
	};
}
/**
* Find the moved message's new UID at the destination folder using the
* fingerprint captured before the Move.
*
* Priority:
*   1) Match by `message_id` (fastest, most reliable). If exactly one live
*      row above the cutoff matches → return it.
*   2) Fingerprint match on (internal_date, size_bytes, subject, from.email)
*      when the message_id was absent OR yielded 0/multiple rows. Only a
*      unique candidate above the cutoff is accepted.
*
* `cutoffUid` is the destination folder's `newest_synced_uid` from BEFORE
* the Move; anything at-or-below cutoff is treated as pre-existing and
* ignored. This blocks stale duplicates (same Message-ID from an older
* send) from being mistaken for the just-moved copy.
*
* Returns `null` when 0 or >1 candidates remain — callers surface this as
* `destinationReady: false` rather than guessing a UID.
*/
async function discoverDestinationUid(supabase, params) {
	const acceptable = (rows) => {
		if (rows.length !== 1) return null;
		const r = rows[0];
		const uid = Number(r.uid);
		const uidvalidity = Number(r.uidvalidity);
		if (!Number.isInteger(uid) || uid <= 0) return null;
		if (!Number.isInteger(uidvalidity) || uidvalidity <= 0) return null;
		return {
			uid,
			uidvalidity
		};
	};
	if (params.fingerprint.messageId) {
		const q = await supabase.from("mail_messages").select("uid, uidvalidity").eq("account_id", params.accountId).eq("folder_id", params.folderId).eq("uidvalidity", params.uidvalidity).eq("message_id", params.fingerprint.messageId).gt("uid", params.cutoffUid).is("deleted_at", null);
		if (q.error) throw q.error;
		const hit = acceptable(q.data ?? []);
		if (hit) return hit;
	}
	const fp = params.fingerprint;
	if (fp.internalDate == null || fp.sizeBytes == null) return null;
	let q = supabase.from("mail_messages").select("uid, uidvalidity, from_addr, subject").eq("account_id", params.accountId).eq("folder_id", params.folderId).eq("uidvalidity", params.uidvalidity).eq("internal_date", fp.internalDate).eq("size_bytes", fp.sizeBytes).gt("uid", params.cutoffUid).is("deleted_at", null);
	if (fp.subject != null) q = q.eq("subject", fp.subject);
	const res = await q;
	if (res.error) throw res.error;
	const rows = res.data ?? [];
	return acceptable(fp.fromEmail ? rows.filter((r) => {
		const f = r.from_addr;
		return (f && typeof f === "object" && typeof f.email === "string" ? f.email.toLowerCase() : null) === fp.fromEmail;
	}) : rows);
}
async function tombstoneSourceRow(supabase, params) {
	const up = await supabase.from("mail_messages").update({ deleted_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("account_id", params.accountId).eq("folder_id", params.folderId).eq("uidvalidity", params.uidvalidity).eq("uid", params.uid).is("deleted_at", null).select("id, seen").maybeSingle();
	if (up.error) throw up.error;
	if (!up.data?.id) return { changed: false };
	return {
		changed: true,
		wasUnread: !up.data.seen
	};
}
/**
* Copy the source row's envelope into a fresh destination row at the given
* (folderId, uidvalidity, uid).
*
* BLOCKER_7 (upsert race safety): uses `ignoreDuplicates: true` + `.select()`
* so the DB — not us — decides whether an insert actually happened. If a
* racing incremental sync already inserted this (folder, uidvalidity, uid)
* row, its NEWER data is preserved (we do NOT overwrite with the source
* envelope), and we return `{ inserted: false }`. Callers use that flag to
* skip the destination counter increment (Sync's refreshFolderCounts owns
* the count in that case) and avoid double-counting.
*/
async function insertDestinationRowFromSource(supabase, args) {
	const src = await supabase.from("mail_messages").select("modseq, message_id, in_reply_to, subject, from_addr, to_addrs, cc_addrs, internal_date, size_bytes, has_attachments, seen, flagged, answered, draft, keywords").eq("account_id", args.accountId).eq("folder_id", args.sourceFolderId).eq("uidvalidity", args.sourceUidvalidity).eq("uid", args.sourceUid).maybeSingle();
	if (src.error) throw src.error;
	if (!src.data) return null;
	const row = {
		account_id: args.accountId,
		company_id: args.companyId,
		folder_id: args.destinationFolderId,
		uid: args.destinationUid,
		uidvalidity: args.destinationUidvalidity,
		modseq: null,
		message_id: src.data.message_id,
		in_reply_to: src.data.in_reply_to,
		subject: src.data.subject,
		from_addr: src.data.from_addr,
		to_addrs: src.data.to_addrs,
		cc_addrs: src.data.cc_addrs,
		internal_date: src.data.internal_date,
		size_bytes: src.data.size_bytes,
		has_attachments: src.data.has_attachments,
		seen: src.data.seen,
		flagged: src.data.flagged,
		answered: src.data.answered,
		draft: src.data.draft,
		keywords: src.data.keywords,
		deleted_at: null
	};
	const up = await supabase.from("mail_messages").upsert(row, {
		onConflict: "account_id,folder_id,uidvalidity,uid",
		ignoreDuplicates: true
	}).select("id");
	if (up.error) throw up.error;
	return {
		inserted: Array.isArray(up.data) && up.data.length > 0,
		wasUnread: !src.data.seen
	};
}
/**
* Apply a total/unread delta to a folder row via the approved atomic RPC
* `public.adjust_mail_folder_counts_atomic`. BLOCKER_4: this is the ONLY
* path allowed to mutate folder counts on the Move / Delete / Restore
* write-through hot paths — a Read-Modify-Write is unsafe under
* concurrent bulk operations.
*
* `accountId` and `companyId` are REQUIRED so the RPC can enforce identity
* (guards against a folderId collision across companies / accounts).
*/
async function adjustFolderCountsDelta(supabase, params) {
	const rpc = await supabase.rpc("adjust_mail_folder_counts_atomic", {
		p_folder_id: params.folderId,
		p_account_id: params.accountId,
		p_company_id: params.companyId,
		p_total_delta: params.totalDelta,
		p_unread_delta: params.unreadDelta
	});
	if (rpc.error) throw rpc.error;
}
/**
* Bump the destination folder's `uidnext` past the newly-arrived UID so a
* subsequent incremental sync knows about the new tail. Safe no-op when
* the destination folder row is missing.
*/
async function bumpFolderUidnext(supabase, params) {
	const sel = await supabase.from("mail_folders").select("uidnext").eq("id", params.folderId).maybeSingle();
	if (sel.error) throw sel.error;
	if (!sel.data) return;
	const cur = sel.data.uidnext == null ? 0 : Number(sel.data.uidnext);
	if (params.uidnext > cur) {
		const up = await supabase.from("mail_folders").update({ uidnext: params.uidnext }).eq("id", params.folderId);
		if (up.error) throw up.error;
	}
}
async function applyMoveWriteThrough(supabase, input) {
	const src = await resolveFolderByCanonical(supabase, input.accountId, input.companyId, input.sourceCanonical);
	if (!src) return {
		ok: true,
		applied: "no-source-folder",
		sourceTombstoned: false,
		destinationInserted: false
	};
	if (src.uidvalidity == null) return {
		ok: true,
		applied: "no-source-folder",
		sourceTombstoned: false,
		destinationInserted: false
	};
	const tomb = await tombstoneSourceRow(supabase, {
		accountId: input.accountId,
		folderId: src.id,
		uidvalidity: src.uidvalidity,
		uid: input.sourceUid
	});
	const sourceTombstoned = tomb.changed;
	if (tomb.changed) await adjustFolderCountsDelta(supabase, {
		folderId: src.id,
		accountId: input.accountId,
		companyId: input.companyId,
		totalDelta: -1,
		unreadDelta: tomb.wasUnread ? -1 : 0
	});
	let destinationInserted = false;
	const destUidNum = typeof input.destinationUid === "number" && Number.isFinite(input.destinationUid) ? input.destinationUid : null;
	const destUvStr = input.destinationUidValidity ?? null;
	if (input.uidMappingAvailable && destUidNum != null && destUvStr != null) {
		let dst = await resolveFolderByCanonical(supabase, input.accountId, input.companyId, input.destCanonical);
		if (!dst && input.destinationPath) dst = await resolveFolderByPath(supabase, input.accountId, input.destinationPath, input.companyId);
		if (dst && dst.uidvalidity != null && String(dst.uidvalidity) === destUvStr && tomb.changed) {
			const ins = await insertDestinationRowFromSource(supabase, {
				accountId: input.accountId,
				companyId: input.companyId,
				sourceFolderId: src.id,
				sourceUidvalidity: src.uidvalidity,
				sourceUid: input.sourceUid,
				destinationFolderId: dst.id,
				destinationUidvalidity: Number(destUvStr),
				destinationUid: destUidNum
			});
			if (ins && ins.inserted) {
				destinationInserted = true;
				await adjustFolderCountsDelta(supabase, {
					folderId: dst.id,
					accountId: input.accountId,
					companyId: input.companyId,
					totalDelta: 1,
					unreadDelta: ins.wasUnread ? 1 : 0
				});
				await bumpFolderUidnext(supabase, {
					folderId: dst.id,
					uidnext: destUidNum + 1
				});
			}
		}
	}
	return {
		ok: true,
		applied: destinationInserted ? "full" : "source-only",
		sourceTombstoned,
		destinationInserted
	};
}
//#endregion
export { applyMoveWriteThrough, captureSourceFingerprint, discoverDestinationUid, normalizeCanonicalForIndex, resolveFolderByCanonical, tombstoneSourceRow };
