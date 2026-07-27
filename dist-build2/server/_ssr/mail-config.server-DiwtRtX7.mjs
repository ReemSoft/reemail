//#region node_modules/.nitro/vite/services/ssr/assets/mail-config.server-DiwtRtX7.js
var MailAccountNotFoundError = class extends Error {
	code = "MAIL_ACCOUNT_NOT_FOUND";
	constructor() {
		super("MAIL_ACCOUNT_NOT_FOUND");
	}
};
var MailAccountCompanyMismatchError = class extends Error {
	code = "MAIL_ACCOUNT_COMPANY_MISMATCH";
	constructor() {
		super("MAIL_ACCOUNT_COMPANY_MISMATCH");
	}
};
var MailConfigIncompleteError = class extends Error {
	code = "MAIL_CONFIG_INCOMPLETE";
	constructor() {
		super("MAIL_CONFIG_INCOMPLETE");
	}
};
/**
* Loads the mail account row and merges in domain defaults where the
* per-account IMAP/SMTP fields are missing. Returns a fully-populated
* config or throws a typed error.
*
* The company_id in the JWT claims is authoritative: even though the row is
* fetched by primary key, we additionally filter by company_id so a caller
* cannot use a stolen sub with a different cid.
*/
async function resolveMailConfigForAccount(admin, accountId, companyId) {
	const { data: acc, error } = await admin.from("mail_accounts").select("id, company_id, email_address, normalized_email, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, source_domain_id").eq("id", accountId).maybeSingle();
	if (error) throw error;
	if (!acc) throw new MailAccountNotFoundError();
	if (acc.company_id !== companyId) throw new MailAccountCompanyMismatchError();
	let imapHost = acc.imap_host;
	let imapPort = acc.imap_port;
	let imapSecure = acc.imap_secure;
	let smtpHost = acc.smtp_host;
	let smtpPort = acc.smtp_port;
	let smtpSecure = acc.smtp_secure;
	if (!imapHost || imapPort == null || imapSecure == null || !smtpHost || smtpPort == null || smtpSecure == null) {
		const domainPart = (acc.email_address ?? "").split("@")[1]?.toLowerCase() ?? "";
		if (domainPart) {
			let q = admin.from("email_domains").select("id, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure").eq("company_id", companyId).ilike("domain", domainPart);
			if (acc.source_domain_id) q = q.eq("id", acc.source_domain_id);
			const { data: rows } = await q.limit(1);
			const d = rows?.[0];
			if (d) {
				imapHost = imapHost ?? d.imap_host;
				imapPort = imapPort ?? d.imap_port;
				imapSecure = imapSecure ?? d.imap_secure;
				smtpHost = smtpHost ?? d.smtp_host;
				smtpPort = smtpPort ?? d.smtp_port;
				smtpSecure = smtpSecure ?? d.smtp_secure;
			}
		}
	}
	if (!imapHost || imapPort == null || imapSecure == null || !smtpHost || smtpPort == null || smtpSecure == null) throw new MailConfigIncompleteError();
	return {
		accountId: acc.id,
		companyId: acc.company_id,
		emailAddress: acc.email_address,
		normalizedEmail: acc.normalized_email ?? (acc.email_address ?? "").toLowerCase().trim(),
		displayName: acc.display_name ?? null,
		imapHost,
		imapPort,
		imapSecure,
		smtpHost,
		smtpPort,
		smtpSecure,
		sourceDomainId: acc.source_domain_id ?? null
	};
}
//#endregion
export { MailAccountCompanyMismatchError, MailAccountNotFoundError, MailConfigIncompleteError, resolveMailConfigForAccount };
