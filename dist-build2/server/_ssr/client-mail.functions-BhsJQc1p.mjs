import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import processModule from "node:process";
//#region node_modules/.nitro/vite/services/ssr/assets/client-mail.functions-BhsJQc1p.js
/**
* Client (email-owner) login.
* The client is NOT a platform user — they are simply the owner of an email
* address the company admin has configured. We look up the mail_account by
* email, then verify the password directly against the real IMAP server via
* the bridge. The password stays only in the browser session, never in the database.
*/
var clientLogin_createServerFn_handler = createServerRpc({
	id: "c2210e0ba513c48e31fc17077913076ad44a2f9a1f80e27805c5301fbc1f8a10",
	name: "clientLogin",
	filename: "src/lib/client-mail.functions.ts"
}, (opts) => clientLogin.__executeServer(opts));
var clientLogin = createServerFn({ method: "POST" }).inputValidator((input) => {
	if (!input.email || !input.email.includes("@")) return {
		email: "",
		password: input.password ?? "",
		validationError: "بريد غير صالح"
	};
	if (!input.password || input.password.length < 3) return {
		email: input.email.trim().toLowerCase(),
		password: input.password ?? "",
		validationError: "كلمة المرور مطلوبة"
	};
	return {
		email: input.email.trim().toLowerCase(),
		password: input.password
	};
}).handler(clientLogin_createServerFn_handler, async ({ data }) => {
	if ("validationError" in data) return {
		ok: false,
		message: data.validationError
	};
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const domainPart = data.email.split("@")[1]?.toLowerCase() ?? "";
	const { data: account, error } = await supabaseAdmin.from("mail_accounts").select("id, company_id, email_address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure").ilike("email_address", data.email).maybeSingle();
	if (error) return {
		ok: false,
		message: "تعذر التحقق من البريد الآن. حاول مرة أخرى."
	};
	async function loadDomainDefaults(companyId) {
		let q = supabaseAdmin.from("email_domains").select("id, company_id, domain, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure").ilike("domain", domainPart);
		if (companyId) q = q.eq("company_id", companyId);
		const { data: rows } = await q;
		return rows ?? [];
	}
	let resolved = account ? { ...account } : null;
	if (resolved && (!resolved.imap_host || !resolved.smtp_host)) {
		const d = (await loadDomainDefaults(resolved.company_id))[0];
		if (d) {
			resolved.imap_host = resolved.imap_host ?? d.imap_host;
			resolved.imap_port = resolved.imap_port ?? d.imap_port;
			resolved.imap_secure = resolved.imap_secure ?? d.imap_secure;
			resolved.smtp_host = resolved.smtp_host ?? d.smtp_host;
			resolved.smtp_port = resolved.smtp_port ?? d.smtp_port;
			resolved.smtp_secure = resolved.smtp_secure ?? d.smtp_secure;
		}
	}
	if (!resolved) {
		if (!domainPart) return {
			ok: false,
			message: "بريد غير صالح"
		};
		const defaults = await loadDomainDefaults();
		if (defaults.length === 0) return {
			ok: false,
			message: "هذا البريد غير مُسجّل. تواصل مع شركتك."
		};
		if (defaults.length > 1) return {
			ok: false,
			message: "هذا الدومين مُسجّل لدى أكثر من شركة. اطلب من شركتك إضافة بريدك."
		};
		const d = defaults[0];
		resolved = {
			id: `domain:${d.id}`,
			company_id: d.company_id,
			email_address: data.email,
			display_name: null,
			imap_host: d.imap_host,
			imap_port: d.imap_port,
			imap_secure: d.imap_secure,
			smtp_host: d.smtp_host,
			smtp_port: d.smtp_port,
			smtp_secure: d.smtp_secure
		};
	}
	if (!resolved.imap_host || !resolved.imap_port || resolved.imap_secure == null || !resolved.smtp_host || !resolved.smtp_port || resolved.smtp_secure == null) return {
		ok: false,
		message: "إعدادات البريد لهذا الحساب غير مكتملة. تواصل مع المشرف."
	};
	const configuredAccount = {
		id: resolved.id,
		company_id: resolved.company_id,
		email_address: resolved.email_address,
		display_name: resolved.display_name,
		imap_host: resolved.imap_host,
		imap_port: resolved.imap_port,
		imap_secure: resolved.imap_secure,
		smtp_host: resolved.smtp_host,
		smtp_port: resolved.smtp_port,
		smtp_secure: resolved.smtp_secure
	};
	const { data: company } = await supabaseAdmin.from("companies").select("id, name, app_name, logo_url, brand_primary, brand_accent").eq("id", configuredAccount.company_id).maybeSingle();
	const bridgeUrl = processModule.env.MAIL_BRIDGE_URL;
	const bridgeKey = processModule.env.MAIL_BRIDGE_SECRET;
	if (!bridgeUrl || !bridgeKey) return {
		ok: false,
		message: "خادم البريد لم يُربط بعد. أخبر فريق الدعم برابط الـ Bridge."
	};
	try {
		const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/api/verify`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Bridge-Key": bridgeKey
			},
			body: JSON.stringify({
				account: {
					email_address: configuredAccount.email_address,
					display_name: configuredAccount.display_name,
					imap_host: configuredAccount.imap_host,
					imap_port: configuredAccount.imap_port,
					imap_secure: configuredAccount.imap_secure,
					smtp_host: configuredAccount.smtp_host,
					smtp_port: configuredAccount.smtp_port,
					smtp_secure: configuredAccount.smtp_secure
				},
				password: data.password
			})
		});
		const rawText = await res.text();
		let json = {};
		try {
			json = JSON.parse(rawText);
		} catch {}
		if (!res.ok || !json.ok) {
			console.error("[clientLogin] bridge verify failed", {
				status: res.status,
				bridgeUrl,
				bridgeKeyPrefix: bridgeKey.slice(0, 6),
				body: rawText.slice(0, 300)
			});
			return {
				ok: false,
				message: `فشل التحقق (${res.status}): ${json.error || rawText.slice(0, 120) || "خطأ غير معروف"}`
			};
		}
	} catch (err) {
		console.error("[clientLogin] bridge fetch threw", err);
		return {
			ok: false,
			message: `تعذر الاتصال بخادم البريد: ${err instanceof Error ? err.message : String(err)}`
		};
	}
	const isDomainDerived = typeof resolved.id === "string" && resolved.id.startsWith("domain:");
	const sourceDomainId = isDomainDerived ? resolved.id.slice(7) : null;
	const { findOrCreateMailAccountIdentity, MailAccountOwnershipConflictError, MailAccountSourceMismatchError, normalizeEmail } = await import("./mail-account-identity.server-Damq9Wup.mjs");
	let identity;
	try {
		identity = await findOrCreateMailAccountIdentity(supabaseAdmin, {
			companyId: resolved.company_id,
			emailAddress: resolved.email_address,
			displayName: resolved.display_name,
			sourceDomainId,
			accountSource: isDomainDerived ? "domain" : "manual"
		});
	} catch (e) {
		if (e instanceof MailAccountOwnershipConflictError) return {
			ok: false,
			message: "تعذر ربط عنوان البريد بهذا الحساب. تحقق من بيانات الحساب أو تواصل مع مسؤول النظام."
		};
		if (e instanceof MailAccountSourceMismatchError) return {
			ok: false,
			message: "تعارض في مصدر إعدادات هذا الحساب. تواصل مع مشرف شركتك."
		};
		console.error("[clientLogin] identity resolution failed", e);
		return {
			ok: false,
			message: "تعذر تجهيز هوية الحساب. حاول مرة أخرى."
		};
	}
	const { issueMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
	let tokenInfo;
	try {
		tokenInfo = await issueMailSessionToken({
			accountId: identity.id,
			companyId: identity.companyId,
			normalizedEmail: normalizeEmail(identity.emailAddress)
		});
	} catch (e) {
		console.error("[clientLogin] issue mail session token failed", e);
		return {
			ok: false,
			message: "تعذر إصدار جلسة البريد الآمنة. حاول لاحقاً."
		};
	}
	return {
		ok: true,
		account: {
			...configuredAccount,
			id: identity.id
		},
		company,
		mailSessionToken: tokenInfo.token,
		mailSessionTokenExpiresAt: tokenInfo.expiresAt
	};
});
//#endregion
export { clientLogin_createServerFn_handler };
