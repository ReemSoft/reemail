import { Buffer } from "node:buffer";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-index-row-CcyEY5HA.js
function coerceAddress(v) {
	if (v && typeof v === "object") {
		const o = v;
		const email = typeof o.email === "string" ? o.email : "";
		return {
			name: typeof o.name === "string" && o.name.length ? o.name : email,
			email
		};
	}
	return {
		name: "",
		email: ""
	};
}
function coerceAddressList(v) {
	if (!Array.isArray(v)) return [];
	return v.map(coerceAddress).filter((a) => a.email.length > 0 || a.name.length > 0);
}
/**
* Map a stored index row to the UI's MailMessage contract. The index does not
* persist body/preview — the client fetches those on-open via the existing
* per-message bridge fetcher, so `body` and `preview` are left empty.
*/
function indexRowToMailMessage(folder, row) {
	const to = coerceAddressList(row.to_addrs);
	const cc = coerceAddressList(row.cc_addrs);
	return {
		id: `${folder}:${row.uid}`,
		threadId: row.message_id ?? `${folder}:${row.uid}`,
		folder,
		from: coerceAddress(row.from_addr),
		to,
		cc: cc.length ? cc : void 0,
		subject: row.subject ?? "",
		preview: "",
		body: "",
		date: row.internal_date ?? (/* @__PURE__ */ new Date(0)).toISOString(),
		read: !!row.seen,
		starred: !!row.flagged,
		hasAttachments: !!row.has_attachments
	};
}
/**
* Encode/decode the compound cursor as an opaque base64 string so callers
* don't need to know the internal shape.
*/
function encodeIndexCursor(c) {
	return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeIndexCursor(s) {
	try {
		const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
		if (parsed && typeof parsed === "object" && typeof parsed.date === "string" && typeof parsed.id === "string") return parsed;
		return null;
	} catch {
		return null;
	}
}
//#endregion
export { decodeIndexCursor, encodeIndexCursor, indexRowToMailMessage };
