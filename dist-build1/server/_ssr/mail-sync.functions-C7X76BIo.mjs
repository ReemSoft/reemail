import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { a as numberType, n as booleanType, o as objectType, r as enumType, s as stringType } from "../_libs/zod.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-sync.functions-C7X76BIo.js
var AccountShape = objectType({
	email_address: stringType().email().max(320),
	display_name: stringType().nullable().optional(),
	imap_host: stringType().min(1).max(255),
	imap_port: numberType().int().positive().max(65535),
	imap_secure: booleanType(),
	smtp_host: stringType().min(1).max(255),
	smtp_port: numberType().int().positive().max(65535),
	smtp_secure: booleanType()
});
var InputSchema = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	password: stringType().min(1).max(1024),
	folderPath: stringType().min(1).max(500).default("INBOX"),
	canonical: stringType().min(1).max(32).optional(),
	mode: enumType([
		"initial",
		"incremental",
		"reconcile"
	]),
	limit: numberType().int().positive().max(300).optional(),
	fromUid: numberType().int().positive().optional(),
	toUid: numberType().int().positive().optional(),
	flagsFromUid: numberType().int().positive().optional(),
	flagsToUid: numberType().int().positive().optional()
}).strict();
var runMailSync_createServerFn_handler = createServerRpc({
	id: "acdd37ebda76688b0815318aa8dd7bd40f42721d320b2ef20860693ffdf22fa4",
	name: "runMailSync",
	filename: "src/lib/mail-sync.functions.ts"
}, (opts) => runMailSync.__executeServer(opts));
var runMailSync = createServerFn({ method: "POST" }).inputValidator((input) => InputSchema.parse(input)).handler(runMailSync_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { verifyMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
	const { resolveMailConfigForAccount, MailAccountNotFoundError, MailAccountCompanyMismatchError, MailConfigIncompleteError } = await import("./mail-config.server-DiwtRtX7.mjs");
	const { runMailSyncCore } = await import("./mail-sync-runner.server-Ct6EWo-P.mjs");
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
		console.error("[runMailSync] resolveConfig failed", e);
		return {
			ok: false,
			error: "تعذر تحميل إعدادات البريد.",
			code: "CONFIG_LOAD_FAILED"
		};
	}
	return runMailSyncCore(supabaseAdmin, {
		accountId,
		companyId,
		bridgeAccount: AccountShape.parse({
			email_address: cfg.emailAddress,
			display_name: cfg.displayName,
			imap_host: cfg.imapHost,
			imap_port: cfg.imapPort,
			imap_secure: cfg.imapSecure,
			smtp_host: cfg.smtpHost,
			smtp_port: cfg.smtpPort,
			smtp_secure: cfg.smtpSecure
		}),
		password: data.password,
		folderPath: data.folderPath,
		canonical: data.canonical ?? null,
		mode: data.mode,
		limit: data.limit,
		fromUid: data.fromUid,
		toUid: data.toUid,
		flagsFromUid: data.flagsFromUid,
		flagsToUid: data.flagsToUid
	});
});
//#endregion
export { runMailSync_createServerFn_handler };
