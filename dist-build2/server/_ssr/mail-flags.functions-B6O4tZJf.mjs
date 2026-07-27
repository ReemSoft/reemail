import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { a as numberType, n as booleanType, o as objectType, r as enumType, s as stringType } from "../_libs/zod.mjs";
import processModule from "node:process";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-flags.functions-B6O4tZJf.js
var CanonicalSchema = enumType([
	"inbox",
	"starred",
	"sent",
	"drafts",
	"spam",
	"trash",
	"archive",
	"all"
]);
var InputSchema = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	password: stringType().min(1).max(1024),
	canonical: CanonicalSchema,
	uid: numberType().int().positive(),
	kind: enumType(["seen", "flagged"]),
	value: booleanType()
}).strict();
var indexUpdateFlag_createServerFn_handler = createServerRpc({
	id: "3b6f2b9b4961ae54be116abbeaac1d639b00c2e0fbec888022f7870e0c699858",
	name: "indexUpdateFlag",
	filename: "src/lib/mail-flags.functions.ts"
}, (opts) => indexUpdateFlag.__executeServer(opts));
var indexUpdateFlag = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema.parse(v)).handler(indexUpdateFlag_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { verifyMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
	const { resolveMailConfigForAccount, MailAccountNotFoundError, MailAccountCompanyMismatchError, MailConfigIncompleteError } = await import("./mail-config.server-DiwtRtX7.mjs");
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
	let cfg;
	try {
		cfg = await resolveMailConfigForAccount(supabaseAdmin, accountId, companyId);
	} catch (e) {
		if (e instanceof MailAccountNotFoundError) return {
			ok: false,
			error: "الحساب غير موجود.",
			code: e.code
		};
		if (e instanceof MailAccountCompanyMismatchError) return {
			ok: false,
			error: "تعارض هوية الحساب.",
			code: e.code
		};
		if (e instanceof MailConfigIncompleteError) return {
			ok: false,
			error: "إعدادات البريد غير مكتملة.",
			code: e.code
		};
		console.error("[indexUpdateFlag] resolveConfig failed", e);
		return {
			ok: false,
			error: "تعذر تحميل الإعدادات.",
			code: "CONFIG_LOAD_FAILED"
		};
	}
	const url = processModule.env.MAIL_BRIDGE_URL;
	const key = processModule.env.MAIL_BRIDGE_SECRET;
	if (!url || !key) return {
		ok: false,
		error: "لم يتم ربط خادم البريد.",
		code: "BRIDGE_NOT_CONFIGURED"
	};
	const path = data.kind === "seen" ? "/api/mark-read" : "/api/star";
	const bridgeBody = {
		account: {
			email_address: cfg.emailAddress,
			display_name: cfg.displayName,
			imap_host: cfg.imapHost,
			imap_port: cfg.imapPort,
			imap_secure: cfg.imapSecure,
			smtp_host: cfg.smtpHost,
			smtp_port: cfg.smtpPort,
			smtp_secure: cfg.smtpSecure
		},
		password: data.password,
		folder: data.canonical,
		uid: data.uid
	};
	if (data.kind === "seen") bridgeBody.read = data.value;
	else bridgeBody.starred = data.value;
	try {
		const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Bridge-Key": key
			},
			body: JSON.stringify(bridgeBody)
		});
		const jsonText = await res.text();
		let j = {};
		try {
			j = JSON.parse(jsonText);
		} catch {}
		if (!res.ok || !j.ok) return {
			ok: false,
			error: j.error || `Bridge error ${res.status}`,
			code: "BRIDGE_MUTATION_FAILED"
		};
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : "Bridge unreachable",
			code: "BRIDGE_UNREACHABLE"
		};
	}
	const { resolveFolderForFlag, updateMessageFlag, recomputeFolderUnread, markFolderNeedsFlagReconcile } = await import("./mail-flags-writer.server-C1eGye7E.mjs");
	let folderId = null;
	try {
		const folder = await resolveFolderForFlag(supabaseAdmin, accountId, companyId, data.canonical === "starred" ? "inbox" : data.canonical);
		if (!folder) return {
			ok: true,
			imap: true,
			index: "no-folder"
		};
		folderId = folder.id;
		await updateMessageFlag(supabaseAdmin, {
			accountId,
			folderId: folder.id,
			uidvalidity: folder.uidvalidity,
			uid: data.uid,
			kind: data.kind,
			value: data.value
		});
		if (data.kind === "seen") try {
			await recomputeFolderUnread(supabaseAdmin, {
				accountId,
				folderId: folder.id,
				uidvalidity: folder.uidvalidity
			});
		} catch (e) {
			console.error("[indexUpdateFlag] unread recount failed", e);
		}
		return {
			ok: true,
			imap: true,
			index: "updated"
		};
	} catch (e) {
		console.error("[indexUpdateFlag] index update failed after IMAP success", e);
		if (folderId) try {
			await markFolderNeedsFlagReconcile(supabaseAdmin, {
				accountId,
				folderId
			});
		} catch (mErr) {
			console.error("[indexUpdateFlag] failed to mark flags_need_reconcile", mErr);
		}
		return {
			ok: true,
			imap: true,
			index: "partial"
		};
	}
});
//#endregion
export { indexUpdateFlag_createServerFn_handler };
