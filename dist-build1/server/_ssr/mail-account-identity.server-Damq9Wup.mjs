//#region node_modules/.nitro/vite/services/ssr/assets/mail-account-identity.server-Damq9Wup.js
function normalizeEmail(raw) {
	return String(raw ?? "").trim().toLowerCase();
}
var MailAccountOwnershipConflictError = class extends Error {
	code = "MAIL_ACCOUNT_OWNERSHIP_CONFLICT";
	constructor() {
		super("MAIL_ACCOUNT_OWNERSHIP_CONFLICT");
	}
};
var MailAccountSourceMismatchError = class extends Error {
	code = "MAIL_ACCOUNT_SOURCE_MISMATCH";
	constructor() {
		super("MAIL_ACCOUNT_SOURCE_MISMATCH");
	}
};
async function readByNormalizedEmail(admin, normalized) {
	const { data, error } = await admin.from("mail_accounts").select("id, company_id, email_address, normalized_email, source_domain_id").eq("normalized_email", normalized).maybeSingle();
	if (error) throw error;
	return data;
}
/**
* Resolve or create the permanent UUID identity for a mailbox.
* MUST be called only AFTER Bridge /api/verify succeeded.
* Never persists the password.
*/
async function findOrCreateMailAccountIdentity(admin, input) {
	const normalized = normalizeEmail(input.emailAddress);
	if (!normalized || !normalized.includes("@")) throw new Error("Invalid email");
	if (!input.companyId) throw new Error("companyId required");
	const existing = await readByNormalizedEmail(admin, normalized);
	if (existing) {
		if (existing.company_id !== input.companyId) throw new MailAccountOwnershipConflictError();
		if (input.accountSource === "domain" && input.sourceDomainId && existing.source_domain_id && existing.source_domain_id !== input.sourceDomainId) throw new MailAccountSourceMismatchError();
		return {
			id: existing.id,
			companyId: existing.company_id,
			emailAddress: existing.email_address,
			normalizedEmail: existing.normalized_email ?? normalized,
			sourceDomainId: existing.source_domain_id ?? null
		};
	}
	const insertRow = {
		company_id: input.companyId,
		email_address: normalized,
		display_name: input.displayName ?? null,
		source_domain_id: input.accountSource === "domain" ? input.sourceDomainId ?? null : null
	};
	const { data: inserted, error: insertErr } = await admin.from("mail_accounts").insert(insertRow).select("id, company_id, email_address, normalized_email, source_domain_id").maybeSingle();
	if (insertErr) {
		if (insertErr.code === "23505" || /duplicate key|unique/i.test(insertErr.message ?? "")) {
			const again = await readByNormalizedEmail(admin, normalized);
			if (again) {
				if (again.company_id !== input.companyId) throw new MailAccountOwnershipConflictError();
				return {
					id: again.id,
					companyId: again.company_id,
					emailAddress: again.email_address,
					normalizedEmail: again.normalized_email ?? normalized,
					sourceDomainId: again.source_domain_id ?? null
				};
			}
		}
		throw insertErr;
	}
	if (!inserted) throw new Error("Insert returned no row");
	return {
		id: inserted.id,
		companyId: inserted.company_id,
		emailAddress: inserted.email_address,
		normalizedEmail: inserted.normalized_email ?? normalized,
		sourceDomainId: inserted.source_domain_id ?? null
	};
}
//#endregion
export { MailAccountOwnershipConflictError, MailAccountSourceMismatchError, findOrCreateMailAccountIdentity, normalizeEmail };
