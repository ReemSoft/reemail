import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { a as numberType, n as booleanType, o as objectType, r as enumType, s as stringType, t as arrayType } from "../_libs/zod.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-bridge.functions-C9GbVylE.js
/**
* Map a bridge-call failure to the typed error code the UI consumes.
*
* Rules (locked by tests):
*   * `unavailable === true`                 -> "UNAVAILABLE"
*   * HTTP 404                                -> "NOT_FOUND"
*   * HTTP 401 / 403                          -> "UNAUTHORIZED"
*   * `status == null` (fetch threw / abort)  -> "NETWORK"
*   * everything else                         -> "UNKNOWN"
*
* A NETWORK / UNKNOWN / UNAUTHORIZED / UNAVAILABLE response MUST NEVER be
* turned into NOT_FOUND — that would let a transient hiccup silently
* tombstone a real row.
*/
function classifyBridgeMessageFailure(failure) {
	if (failure.unavailable) return "UNAVAILABLE";
	if (failure.status === 404) return "NOT_FOUND";
	if (failure.status === 401 || failure.status === 403) return "UNAUTHORIZED";
	if (failure.status == null) return "NETWORK";
	return "UNKNOWN";
}
var FolderSchema = enumType([
	"inbox",
	"starred",
	"sent",
	"drafts",
	"spam",
	"trash",
	"archive",
	"all"
]);
var AuthSchema = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	password: stringType().min(1).max(1024)
});
var FolderPayloadSchema = AuthSchema.extend({
	folder: FolderSchema,
	limit: numberType().int().nonnegative().max(500).optional().default(50),
	offset: numberType().int().nonnegative().max(1e5).optional().default(0),
	sort: enumType([
		"date-desc",
		"date-asc",
		"unread-first",
		"starred-first"
	]).optional()
});
var MessagePayloadSchema = AuthSchema.extend({
	folder: FolderSchema,
	uid: numberType().int().positive()
});
var MarkReadPayloadSchema = MessagePayloadSchema.extend({ read: booleanType() });
var StarPayloadSchema = MessagePayloadSchema.extend({ starred: booleanType() });
var MovePayloadSchema = MessagePayloadSchema.extend({ toFolder: FolderSchema });
var AddressSchema = objectType({
	name: stringType().max(256),
	email: stringType().email().max(320)
});
var SendPayloadSchema = AuthSchema.extend({
	to: arrayType(AddressSchema).min(1).max(100),
	cc: arrayType(AddressSchema).max(100).optional().default([]),
	bcc: arrayType(AddressSchema).max(100).optional().default([]),
	subject: stringType().min(1).max(998),
	bodyHtml: stringType().max(2e6).optional(),
	bodyText: stringType().max(2e6).optional()
});
var SearchPayloadSchema = AuthSchema.extend({
	folder: FolderSchema,
	query: stringType().min(1).max(1024),
	includeBody: booleanType().optional(),
	limit: numberType().int().positive().max(500).optional()
});
async function bridgeCall(mailSessionToken, path, extraBody, password) {
	const { resolveBridgeAuth } = await import("./mail-bridge-auth.server-buSlOQzn.mjs");
	const auth = await resolveBridgeAuth(mailSessionToken);
	if (!auth.ok) return {
		ok: false,
		error: auth.error,
		unavailable: auth.code === "BRIDGE_NOT_CONFIGURED"
	};
	try {
		const res = await fetch(`${auth.bridgeUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Bridge-Key": auth.bridgeKey
			},
			body: JSON.stringify({
				account: auth.bridgeAccount,
				password,
				...extraBody
			})
		});
		const json = await res.json().catch(() => ({
			ok: false,
			error: "Bridge error"
		}));
		if (!res.ok || !json.ok) return {
			ok: false,
			error: json.error || `Bridge error ${res.status}`,
			status: res.status
		};
		return {
			ok: true,
			json
		};
	} catch (err) {
		return {
			ok: false,
			error: err?.message || "تعذر الاتصال بخادم البريد"
		};
	}
}
var bridgeVerify_createServerFn_handler = createServerRpc({
	id: "327ac5ac0e1714e9f50eb91753d07bf9895efb632982a12c238ef299c3ef508d",
	name: "bridgeVerify",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeVerify.__executeServer(opts));
var bridgeVerify = createServerFn({ method: "POST" }).inputValidator((v) => AuthSchema.parse(v)).handler(bridgeVerify_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/verify", {}, data.password);
	if (!r.ok) return {
		ok: false,
		error: r.error
	};
	return r.json;
});
var bridgeGetFolderCounts_createServerFn_handler = createServerRpc({
	id: "e5583fdf5640d377ae78898feeb5b3b128d34e3c1b64a2e726a8a530edb73efc",
	name: "bridgeGetFolderCounts",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeGetFolderCounts.__executeServer(opts));
var bridgeGetFolderCounts = createServerFn({ method: "POST" }).inputValidator((v) => AuthSchema.parse(v)).handler(bridgeGetFolderCounts_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/folders", {}, data.password);
	if (!r.ok) return {
		ok: false,
		error: r.error,
		counts: []
	};
	return {
		ok: true,
		counts: r.json.counts ?? []
	};
});
var bridgeGetMessages_createServerFn_handler = createServerRpc({
	id: "6c499f2027a99a2541fe81c79775983aa1121e19daac7bb30efeb60724a68ce2",
	name: "bridgeGetMessages",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeGetMessages.__executeServer(opts));
var bridgeGetMessages = createServerFn({ method: "POST" }).inputValidator((v) => FolderPayloadSchema.parse(v)).handler(bridgeGetMessages_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/messages", {
		folder: data.folder,
		limit: data.limit,
		offset: data.offset,
		sort: data.sort
	}, data.password);
	if (!r.ok) return {
		ok: false,
		error: r.error,
		messages: []
	};
	return {
		ok: true,
		messages: r.json.messages ?? []
	};
});
var bridgeGetMessage_createServerFn_handler = createServerRpc({
	id: "470e587b8f39a2eae6f2921521b05513dc06c1a1e18d9ec774287e953d1d3632",
	name: "bridgeGetMessage",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeGetMessage.__executeServer(opts));
var bridgeGetMessage = createServerFn({ method: "POST" }).inputValidator((v) => MessagePayloadSchema.parse(v)).handler(bridgeGetMessage_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/message", {
		folder: data.folder,
		uid: data.uid
	}, data.password);
	if (!r.ok) return {
		ok: false,
		code: classifyBridgeMessageFailure({
			status: r.status,
			unavailable: r.unavailable
		}),
		error: r.error,
		message: null,
		status: r.status
	};
	const msg = r.json.message ?? null;
	if (!msg) return {
		ok: false,
		code: "NOT_FOUND",
		error: "Message not found",
		message: null
	};
	return {
		ok: true,
		message: msg
	};
});
var bridgeMarkRead_createServerFn_handler = createServerRpc({
	id: "e5f6a899687d0f7becc1aa5a6509ec7f3ed92bf56edb2a1b42dcb421fa7aea89",
	name: "bridgeMarkRead",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeMarkRead.__executeServer(opts));
var bridgeMarkRead = createServerFn({ method: "POST" }).inputValidator((v) => MarkReadPayloadSchema.parse(v)).handler(bridgeMarkRead_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/mark-read", {
		folder: data.folder,
		uid: data.uid,
		read: data.read
	}, data.password);
	if (!r.ok) throw new Error(r.error || "فشل تحديث حالة القراءة على الخادم");
	return r.json;
});
var bridgeStar_createServerFn_handler = createServerRpc({
	id: "e0c9f33b894f16849029ea602f0d79a6497ebca59de1257211c34d655aa8c966",
	name: "bridgeStar",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeStar.__executeServer(opts));
var bridgeStar = createServerFn({ method: "POST" }).inputValidator((v) => StarPayloadSchema.parse(v)).handler(bridgeStar_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/star", {
		folder: data.folder,
		uid: data.uid,
		starred: data.starred
	}, data.password);
	if (!r.ok) throw new Error(r.error || "فشل تحديث المميّز على الخادم");
	return r.json;
});
var bridgeMove_createServerFn_handler = createServerRpc({
	id: "59077837af02770e500b75c1ba19c2ee3d51a9684072f6e64732a3110224a1bb",
	name: "bridgeMove",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeMove.__executeServer(opts));
var bridgeMove = createServerFn({ method: "POST" }).inputValidator((v) => MovePayloadSchema.parse(v)).handler(bridgeMove_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/move", {
		folder: data.folder,
		uid: data.uid,
		toFolder: data.toFolder
	}, data.password);
	if (!r.ok) throw new Error(r.error || "فشل نقل الرسالة");
	return {
		ok: true,
		move: r.json.move ?? {
			sourceUid: data.uid,
			uidMappingAvailable: false
		}
	};
});
var bridgeDelete_createServerFn_handler = createServerRpc({
	id: "32db5cdba53eee787a6f7fe1dae32fc98931be298323bd1ceb5529de7a377064",
	name: "bridgeDelete",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeDelete.__executeServer(opts));
var bridgeDelete = createServerFn({ method: "POST" }).inputValidator((v) => MessagePayloadSchema.parse(v)).handler(bridgeDelete_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/delete", {
		folder: data.folder,
		uid: data.uid
	}, data.password);
	if (!r.ok) throw new Error(r.error || "فشل حذف الرسالة");
	const move = r.json.move ?? {
		sourceUid: data.uid,
		uidMappingAvailable: false
	};
	return {
		ok: true,
		kind: r.json.kind ?? "moved-to-trash",
		move
	};
});
var bridgeSearch_createServerFn_handler = createServerRpc({
	id: "9d96f6f53a1b6dd76d3ec63208231f848583d83be1adc6cc36cd4ee3dd6fd762",
	name: "bridgeSearch",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeSearch.__executeServer(opts));
var bridgeSearch = createServerFn({ method: "POST" }).inputValidator((v) => SearchPayloadSchema.parse(v)).handler(bridgeSearch_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/search", {
		folder: data.folder,
		query: data.query,
		includeBody: data.includeBody,
		limit: data.limit
	}, data.password);
	if (!r.ok) return {
		ok: false,
		error: r.error,
		messages: []
	};
	return {
		ok: true,
		messages: r.json.messages ?? []
	};
});
var bridgeSend_createServerFn_handler = createServerRpc({
	id: "ea4b5b84770708bac663897582735c6885a66527eea00e5bae50e8be35b4806d",
	name: "bridgeSend",
	filename: "src/lib/mail-bridge.functions.ts"
}, (opts) => bridgeSend.__executeServer(opts));
var bridgeSend = createServerFn({ method: "POST" }).inputValidator((v) => SendPayloadSchema.parse(v)).handler(bridgeSend_createServerFn_handler, async ({ data }) => {
	const r = await bridgeCall(data.mailSessionToken, "/api/send", {
		to: data.to,
		cc: data.cc,
		bcc: data.bcc,
		subject: data.subject,
		bodyHtml: data.bodyHtml,
		bodyText: data.bodyText
	}, data.password);
	if (!r.ok) return {
		ok: false,
		error: r.error
	};
	return r.json;
});
//#endregion
export { bridgeDelete_createServerFn_handler, bridgeGetFolderCounts_createServerFn_handler, bridgeGetMessage_createServerFn_handler, bridgeGetMessages_createServerFn_handler, bridgeMarkRead_createServerFn_handler, bridgeMove_createServerFn_handler, bridgeSearch_createServerFn_handler, bridgeSend_createServerFn_handler, bridgeStar_createServerFn_handler, bridgeVerify_createServerFn_handler };
