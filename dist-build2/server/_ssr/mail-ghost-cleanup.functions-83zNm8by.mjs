import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { a as numberType, o as objectType, r as enumType, s as stringType } from "../_libs/zod.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-ghost-cleanup.functions-83zNm8by.js
var InputSchema = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	canonical: enumType([
		"inbox",
		"starred",
		"sent",
		"drafts",
		"spam",
		"trash",
		"archive"
	]),
	uid: numberType().int().positive(),
	/**
	* Trusted by the server ONLY for observability + strict scoping. The
	* writer scopes the tombstone update to the folder row resolved by
	* (accountId, companyId, canonical), which is the authoritative
	* identity. `uidvalidity` mismatch here is treated as a "no match"
	* (idempotent no-op) and never decrements counters.
	*/
	uidvalidity: numberType().int().positive().optional()
}).strict();
var tombstoneGhostMessage_createServerFn_handler = createServerRpc({
	id: "b7af3d175c6f1270c274f8b9d0e1b299aeb8350b1583ffbc335e7d134529d077",
	name: "tombstoneGhostMessage",
	filename: "src/lib/mail-ghost-cleanup.functions.ts"
}, (opts) => tombstoneGhostMessage.__executeServer(opts));
var tombstoneGhostMessage = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema.parse(v)).handler(tombstoneGhostMessage_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { verifyMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
	const { applyDeleteWriteThrough } = await import("./mail-delete-writer.server-C5BEZTaX.mjs");
	const { resolveFolderByCanonical } = await import("./mail-move-writer.server-BchvkBzO.mjs");
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
	if (data.uidvalidity != null) try {
		const folder = await resolveFolderByCanonical(supabaseAdmin, accountId, companyId, data.canonical);
		if (folder?.uidvalidity != null && folder.uidvalidity !== data.uidvalidity) return {
			ok: true,
			applied: "uidvalidity-mismatch",
			countsDecremented: false
		};
	} catch (e) {
		console.warn("[ghost-cleanup] uidvalidity precheck skipped:", e);
	}
	try {
		const outcome = await applyDeleteWriteThrough(supabaseAdmin, {
			accountId,
			companyId,
			sourceCanonical: data.canonical,
			sourceUid: data.uid
		});
		if (!outcome.ok) return {
			ok: false,
			error: outcome.error,
			code: "GHOST_CLEANUP_WRITE_FAILED"
		};
		return {
			ok: true,
			applied: outcome.applied,
			countsDecremented: outcome.applied === "tombstoned"
		};
	} catch (e) {
		console.error("[tombstoneGhostMessage] write-through failed", e);
		return {
			ok: false,
			error: e instanceof Error ? e.message : "فشل تنظيف الرسالة العالقة",
			code: "GHOST_CLEANUP_EXCEPTION"
		};
	}
});
//#endregion
export { tombstoneGhostMessage_createServerFn_handler };
