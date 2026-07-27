import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { o as objectType, s as stringType } from "../_libs/zod.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-index-counts.functions-DszTCs7g.js
var InputSchema = objectType({ mailSessionToken: stringType().min(20).max(4096) }).strict();
var indexListFolderCounts_createServerFn_handler = createServerRpc({
	id: "10dfd7142f5adadcb59aa793ba2100c77efe52d0f07feaf12561f06a6e85d912",
	name: "indexListFolderCounts",
	filename: "src/lib/mail-index-counts.functions.ts"
}, (opts) => indexListFolderCounts.__executeServer(opts));
var indexListFolderCounts = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema.parse(v)).handler(indexListFolderCounts_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { verifyMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
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
	const q = await supabaseAdmin.from("mail_folders").select("canonical, total, unread, path, uidvalidity").eq("account_id", claims.sub).eq("company_id", claims.cid);
	if (q.error) {
		console.error("[indexListFolderCounts] query failed", q.error);
		return {
			ok: false,
			error: "تعذر قراءة العدادات.",
			code: "COUNTS_QUERY_FAILED"
		};
	}
	return {
		ok: true,
		counts: (q.data ?? []).filter((r) => r.canonical != null).map((r) => ({
			folder: r.canonical,
			total: r.total ?? 0,
			unread: r.unread ?? 0,
			path: r.path ?? null,
			uidvalidity: r.uidvalidity ?? null,
			hasUidvalidity: r.uidvalidity != null
		}))
	};
});
//#endregion
export { indexListFolderCounts_createServerFn_handler };
