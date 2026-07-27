import { supabaseAdmin } from "./client.server-Bw6iWMJ-.mjs";
import { verifyMailSessionToken } from "./mail-token.server-MkDUXijJ.mjs";
import { MailAccountCompanyMismatchError, MailAccountNotFoundError, MailConfigIncompleteError, resolveMailConfigForAccount } from "./mail-config.server-DiwtRtX7.mjs";
import process from "node:process";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-bridge-auth.server-buSlOQzn.js
async function resolveBridgeAuth(mailSessionToken) {
	let claims;
	try {
		claims = await verifyMailSessionToken(mailSessionToken);
	} catch {
		return {
			ok: false,
			status: 401,
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
			status: 404,
			error: "الحساب غير موجود.",
			code: e.code
		};
		if (e instanceof MailAccountCompanyMismatchError) return {
			ok: false,
			status: 403,
			error: "تعارض هوية الحساب.",
			code: e.code
		};
		if (e instanceof MailConfigIncompleteError) return {
			ok: false,
			status: 409,
			error: "إعدادات البريد غير مكتملة.",
			code: e.code
		};
		console.error("[resolveBridgeAuth] resolveConfig failed", e);
		return {
			ok: false,
			status: 500,
			error: "تعذر تحميل الإعدادات.",
			code: "CONFIG_LOAD_FAILED"
		};
	}
	const bridgeUrl = process.env.MAIL_BRIDGE_URL;
	const bridgeKey = process.env.MAIL_BRIDGE_SECRET;
	if (!bridgeUrl || !bridgeKey) return {
		ok: false,
		status: 503,
		error: "لم يتم ربط خادم البريد.",
		code: "BRIDGE_NOT_CONFIGURED"
	};
	return {
		ok: true,
		accountId,
		companyId,
		cfg,
		bridgeAccount: {
			email_address: cfg.emailAddress,
			display_name: cfg.displayName,
			imap_host: cfg.imapHost,
			imap_port: cfg.imapPort,
			imap_secure: cfg.imapSecure,
			smtp_host: cfg.smtpHost,
			smtp_port: cfg.smtpPort,
			smtp_secure: cfg.smtpSecure
		},
		bridgeUrl: bridgeUrl.replace(/\/$/, ""),
		bridgeKey
	};
}
//#endregion
export { resolveBridgeAuth };
