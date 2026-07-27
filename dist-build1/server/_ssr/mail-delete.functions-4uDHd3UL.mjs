import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { a as numberType, i as literalType, o as objectType, s as stringType } from "../_libs/zod.mjs";
import process from "node:process";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-delete.functions-4uDHd3UL.js
var InputSchema = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	password: stringType().min(1).max(1024),
	canonical: literalType("trash"),
	uid: numberType().int().positive()
}).strict();
var indexDeleteMessage_createServerFn_handler = createServerRpc({
	id: "301bf68a4f567a9e734abfdcac1afaf0bafd91f3350b015b3c702ab471260262",
	name: "indexDeleteMessage",
	filename: "src/lib/mail-delete.functions.ts"
}, (opts) => indexDeleteMessage.__executeServer(opts));
var indexDeleteMessage = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema.parse(v)).handler(indexDeleteMessage_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { verifyMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
	const { resolveMailConfigForAccount, MailAccountNotFoundError, MailAccountCompanyMismatchError, MailConfigIncompleteError } = await import("./mail-config.server-DiwtRtX7.mjs");
	const { applyDeleteWriteThrough } = await import("./mail-delete-writer.server-C5BEZTaX.mjs");
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
		console.error("[indexDeleteMessage] resolveConfig failed", e);
		return {
			ok: false,
			error: "تعذر تحميل الإعدادات.",
			code: "CONFIG_LOAD_FAILED"
		};
	}
	const url = process.env.MAIL_BRIDGE_URL;
	const key = process.env.MAIL_BRIDGE_SECRET;
	if (!url || !key) return {
		ok: false,
		error: "لم يتم ربط خادم البريد.",
		code: "BRIDGE_NOT_CONFIGURED"
	};
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
	let sourceUid;
	try {
		const res = await fetch(`${url.replace(/\/$/, "")}/api/delete`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Bridge-Key": key
			},
			body: JSON.stringify(bridgeBody)
		});
		const text = await res.text();
		let json = {};
		try {
			json = JSON.parse(text);
		} catch {}
		if (!res.ok || !json.ok) return {
			ok: false,
			error: json.error || `Bridge error ${res.status}`,
			code: "BRIDGE_DELETE_FAILED"
		};
		if (json.kind !== "permanent-delete") return {
			ok: false,
			error: `Unexpected bridge kind: ${json.kind ?? "<missing>"}`,
			code: "BRIDGE_UNEXPECTED_KIND"
		};
		sourceUid = typeof json.sourceUid === "number" && Number.isFinite(json.sourceUid) ? json.sourceUid : data.uid;
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : "Bridge unreachable",
			code: "BRIDGE_UNREACHABLE"
		};
	}
	let indexStatus = "partial";
	try {
		const outcome = await applyDeleteWriteThrough(supabaseAdmin, {
			accountId,
			companyId,
			sourceCanonical: data.canonical,
			sourceUid
		});
		indexStatus = outcome.ok ? outcome.applied : "partial";
	} catch (e) {
		console.error("[indexDeleteMessage] index write-through failed after IMAP success", e);
		indexStatus = "partial";
	}
	return {
		ok: true,
		imap: true,
		sourceUid,
		index: indexStatus
	};
});
//#endregion
export { indexDeleteMessage_createServerFn_handler };
