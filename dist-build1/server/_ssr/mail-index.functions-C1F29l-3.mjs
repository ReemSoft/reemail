import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { a as numberType, o as objectType, r as enumType, s as stringType } from "../_libs/zod.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-index.functions-C1F29l-3.js
var InputSchema = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	canonical: enumType([
		"inbox",
		"starred",
		"sent",
		"drafts",
		"spam",
		"trash",
		"archive",
		"all"
	]),
	limit: numberType().int().positive().max(200).default(50),
	cursor: stringType().min(1).max(2048).optional()
}).strict();
var indexListMessages_createServerFn_handler = createServerRpc({
	id: "a1985f859cc5bc1e0b9e353f558f7d9a34fc2937e905f76e70f92c7b3e928f83",
	name: "indexListMessages",
	filename: "src/lib/mail-index.functions.ts"
}, (opts) => indexListMessages.__executeServer(opts));
var indexListMessages = createServerFn({ method: "POST" }).inputValidator((input) => InputSchema.parse(input)).handler(indexListMessages_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { verifyMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
	const { indexRowToMailMessage, encodeIndexCursor, decodeIndexCursor } = await import("./mail-index-row-CcyEY5HA.mjs");
	let claims;
	try {
		claims = await verifyMailSessionToken(data.mailSessionToken);
	} catch {
		return {
			ok: false,
			error: "جلسة البريد غير صالحة أو منتهية.",
			code: "INVALID_TOKEN"
		};
	}
	const accountId = claims.sub;
	const companyId = claims.cid;
	const canonical = data.canonical;
	if (canonical === "starred") return {
		ok: true,
		indexed: false,
		reason: "NO_FOLDER"
	};
	const folderQ = await supabaseAdmin.from("mail_folders").select("id, uidvalidity, total, unread").eq("account_id", accountId).eq("company_id", companyId).eq("canonical", canonical).maybeSingle();
	if (folderQ.error) {
		console.error("[indexListMessages] folder lookup failed", folderQ.error);
		return {
			ok: false,
			error: "تعذر قراءة المجلد.",
			code: "FOLDER_QUERY_FAILED"
		};
	}
	if (!folderQ.data) return {
		ok: true,
		indexed: false,
		reason: "NO_FOLDER"
	};
	if (folderQ.data.uidvalidity == null) return {
		ok: true,
		indexed: false,
		reason: "NO_UIDVALIDITY"
	};
	const folderId = folderQ.data.id;
	const cursor = data.cursor ? decodeIndexCursor(data.cursor) : null;
	const limit = data.limit;
	let q = supabaseAdmin.from("mail_messages").select("id, uid, subject, from_addr, to_addrs, cc_addrs, internal_date, seen, flagged, has_attachments, message_id").eq("account_id", accountId).eq("company_id", companyId).eq("folder_id", folderId).is("deleted_at", null).order("internal_date", {
		ascending: false,
		nullsFirst: false
	}).order("id", { ascending: false }).limit(limit + 1);
	if (cursor) q = q.or(`internal_date.lt.${cursor.date},and(internal_date.eq.${cursor.date},id.lt.${cursor.id})`);
	const pageQ = await q;
	if (pageQ.error) {
		console.error("[indexListMessages] page query failed", pageQ.error);
		return {
			ok: false,
			error: "تعذر قراءة الرسائل.",
			code: "PAGE_QUERY_FAILED"
		};
	}
	const rows = pageQ.data ?? [];
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const messages = pageRows.map((r) => indexRowToMailMessage(canonical, {
		uid: Number(r.uid),
		subject: r.subject,
		from_addr: r.from_addr,
		to_addrs: r.to_addrs,
		cc_addrs: r.cc_addrs,
		internal_date: r.internal_date,
		seen: !!r.seen,
		flagged: !!r.flagged,
		has_attachments: !!r.has_attachments,
		message_id: r.message_id
	}));
	const last = pageRows[pageRows.length - 1];
	return {
		ok: true,
		indexed: true,
		messages,
		nextCursor: hasMore && last && last.internal_date ? encodeIndexCursor({
			date: last.internal_date,
			id: String(last.id)
		}) : null,
		hasMore,
		folderId,
		total: folderQ.data.total ?? 0,
		unread: folderQ.data.unread ?? 0
	};
});
//#endregion
export { indexListMessages_createServerFn_handler };
