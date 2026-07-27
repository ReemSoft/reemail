import { n as __toESM } from "../_runtime.mjs";
import { g as useNavigate, h as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { T as require_jsx_runtime } from "../_libs/@radix-ui/react-alert-dialog+[...].mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
import { n as useServerFn, t as createSsrRpc } from "./createSsrRpc-FHPyW8kf.mjs";
import { n as toast } from "../_libs/sonner.mjs";
import { $ as ChevronLeft, B as FileImage, C as Paperclip, D as Mail, E as Menu, F as Forward, G as EllipsisVertical, H as FileCode, I as FileType, K as Download, L as FileText, M as LoaderCircle, N as Inbox, O as MailOpen, P as Globe, Q as ChevronRight, R as FileSpreadsheet, S as Pencil, T as OctagonAlert, U as FileArchive, V as FileHeadphone, W as Eye, Y as Circle, Z as CircleArrowDown, _ as Reply, a as Trash2, at as Archive, b as Printer, c as SquareMinus, d as ShieldCheck, et as ChevronDown, f as ShieldAlert, h as Search, k as LogOut, l as SquareCheckBig, m as Send, n as X, o as Star, ot as ArchiveRestore, q as Copy, rt as ArrowUpDown, s as Square, t as Zap, tt as Check, v as ReplyAll, y as RefreshCw, z as FilePlay } from "../_libs/lucide-react.mjs";
import { n as cn, r as useConfirm } from "./confirm-provider-DMbkJnjU.mjs";
import { t as useCompanyTheme } from "./use-company-theme-C8pdPbGn.mjs";
import { n as getMailSession, t as clearMailSession } from "./mail-session-j1dYUlkq.mjs";
import { a as numberType, i as literalType, n as booleanType, o as objectType, r as enumType, s as stringType, t as arrayType } from "../_libs/zod.mjs";
import { t as es } from "../_libs/react-virtuoso.mjs";
import { t as purify } from "../_libs/dompurify.mjs";
import { a as Label2, c as Root2, d as SubTrigger2, f as Trigger, i as ItemIndicator2, l as Separator2, n as Content2, o as Portal2, r as Item2, s as RadioItem2, t as CheckboxItem2, u as SubContent2 } from "../_libs/@radix-ui/react-dropdown-menu+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-origin-tracker-CYxBXdpu.js
function finalStorageKey(accountId, kind = "trash") {
	return `mailmaestro:${kind}-origin:v3:${accountId}`;
}
function pendingStorageKey(accountId, kind = "trash") {
	return `mailmaestro:${kind}-pending-origin:v3:${accountId}`;
}
function finalEntryKey(uv, uid) {
	return `${uv}:${uid}`;
}
function pendingEntryKey(sourceCanonical, sourceUid, sourceUidValidity) {
	return `${sourceCanonical}:${sourceUid}:${sourceUidValidity ?? "?"}`;
}
function loadFinal(storage, accountId, kind) {
	try {
		const raw = storage.getItem(finalStorageKey(accountId, kind));
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		return {};
	}
}
function saveFinal(storage, accountId, kind, map) {
	try {
		storage.setItem(finalStorageKey(accountId, kind), JSON.stringify(map));
	} catch {}
}
function loadPending(storage, accountId, kind) {
	try {
		const raw = storage.getItem(pendingStorageKey(accountId, kind));
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		return {};
	}
}
function savePending(storage, accountId, kind, map) {
	try {
		storage.setItem(pendingStorageKey(accountId, kind), JSON.stringify(map));
	} catch {}
}
/**
* Write a FINAL origin. The `originalCanonical` MUST NOT be `"trash"` (that
* would mean "restore back to trash" — nonsensical) when kind is "trash",
* and MUST NOT be `"archive"` when kind is "archive".
*/
function rememberFinalOrigin(storage, key, entry, kind = "trash") {
	if (!key.accountId || !Number.isFinite(key.trashUidValidity) || key.trashUidValidity <= 0 || !Number.isFinite(key.trashUid) || key.trashUid <= 0) return;
	if (entry.originalCanonical === kind) return;
	const map = loadFinal(storage, key.accountId, kind);
	const k = finalEntryKey(key.trashUidValidity, key.trashUid);
	const prev = map[k];
	if (prev && prev.originalCanonical === entry.originalCanonical && (prev.originalPath ?? null) === (entry.originalPath ?? null) && (prev.messageId ?? null) === (entry.messageId ?? null)) return;
	map[k] = {
		originalCanonical: entry.originalCanonical,
		originalPath: entry.originalPath ?? null,
		messageId: entry.messageId ?? null
	};
	saveFinal(storage, key.accountId, kind, map);
}
function rememberPendingOrigin(storage, key, entry, kind = "trash") {
	if (!key.accountId || !key.sourceCanonical || !Number.isFinite(key.sourceUid) || key.sourceUid <= 0) return;
	if (entry.originalCanonical === kind) return;
	const map = loadPending(storage, key.accountId, kind);
	const k = pendingEntryKey(key.sourceCanonical, key.sourceUid, key.sourceUidValidity);
	map[k] = {
		sourceCanonical: key.sourceCanonical,
		sourceUid: key.sourceUid,
		sourceUidValidity: key.sourceUidValidity,
		originalCanonical: entry.originalCanonical,
		originalPath: entry.originalPath ?? null,
		messageId: entry.messageId ?? null,
		fingerprint: entry.fingerprint ?? null,
		createdAt: entry.createdAt || Date.now()
	};
	savePending(storage, key.accountId, kind, map);
}
/** Look up the final origin for a destination identity. Returns `null` when missing. */
function getOrigin(storage, key, kind = "trash") {
	if (!key.accountId || !Number.isFinite(key.trashUidValidity) || key.trashUidValidity <= 0 || !Number.isFinite(key.trashUid) || key.trashUid <= 0) return null;
	return loadFinal(storage, key.accountId, kind)[finalEntryKey(key.trashUidValidity, key.trashUid)] ?? null;
}
function forgetFinalOrigin(storage, key, kind = "trash") {
	if (!key.accountId) return;
	const map = loadFinal(storage, key.accountId, kind);
	const k = finalEntryKey(key.trashUidValidity, key.trashUid);
	if (!(k in map)) return;
	delete map[k];
	saveFinal(storage, key.accountId, kind, map);
}
function forgetPendingOrigin(storage, key, kind = "trash") {
	if (!key.accountId) return;
	const map = loadPending(storage, key.accountId, kind);
	const k = pendingEntryKey(key.sourceCanonical, key.sourceUid, key.sourceUidValidity);
	if (!(k in map)) return;
	delete map[k];
	savePending(storage, key.accountId, kind, map);
}
/**
* Drop every FINAL entry whose destination UIDVALIDITY no longer matches
* the server's current UIDVALIDITY for that folder. Pending entries are
* NOT touched (they hold a SOURCE identity).
*/
function purgeStaleTrashUidValidity(storage, accountId, currentTrashUidValidity, kind = "trash") {
	if (!accountId || !Number.isFinite(currentTrashUidValidity) || currentTrashUidValidity <= 0) return 0;
	const map = loadFinal(storage, accountId, kind);
	let removed = 0;
	let dirty = false;
	for (const k of Object.keys(map)) {
		const colon = k.indexOf(":");
		if (colon <= 0) continue;
		const uv = Number(k.slice(0, colon));
		if (!Number.isFinite(uv) || uv !== currentTrashUidValidity) {
			delete map[k];
			removed++;
			dirty = true;
		}
	}
	if (dirty) saveFinal(storage, accountId, kind, map);
	return removed;
}
/**
* Wipe every v3 origin (final + pending) for `accountId`. Clears BOTH
* trash and archive namespaces so a signed-out or switched account can
* never leak origins into a new session.
*/
function clearAccountOrigins(storage, accountId) {
	if (!accountId) return;
	storage.removeItem(finalStorageKey(accountId, "trash"));
	storage.removeItem(pendingStorageKey(accountId, "trash"));
	storage.removeItem(finalStorageKey(accountId, "archive"));
	storage.removeItem(pendingStorageKey(accountId, "archive"));
}
/**
* Build a conservative fingerprint from immutable fields that survive a
* move to Trash/Archive. `messageId` participates but is NEVER the sole
* key — the fingerprint must also incorporate other fields so two rows
* that happen to share a Message-ID stay distinguishable.
*
* Returns an empty string when no meaningful signal is available; callers
* MUST treat an empty fingerprint as "cannot match".
*/
function buildOriginFingerprint(input) {
	const norm = (v) => (v ?? "").toString().trim().toLowerCase();
	const parts = [
		norm(input.messageId),
		norm(input.fromEmail),
		norm(input.subject),
		norm(input.date),
		input.sizeBytes != null && Number.isFinite(input.sizeBytes) ? String(input.sizeBytes) : ""
	];
	if (parts.filter((p) => p.length > 0).length < 2) return "";
	return parts.join("");
}
/**
* Promote a pending origin to final when EXACTLY ONE pending entry for
* this account+kind matches the destination message's fingerprint.
* Ambiguous matches (0 or >1) are left alone — we never guess.
*
* Returns the promoted FinalOriginEntry, or `null` when no unique match.
*/
function promoteUniquePendingOriginForTrashMessage(storage, input, kind = "trash") {
	if (!input.accountId || !Number.isFinite(input.trashUidValidity) || input.trashUidValidity <= 0 || !Number.isFinite(input.trashUid) || input.trashUid <= 0 || !input.fingerprint) return null;
	const pending = loadPending(storage, input.accountId, kind);
	const finals = loadFinal(storage, input.accountId, kind);
	if (finals[finalEntryKey(input.trashUidValidity, input.trashUid)]) return null;
	let matchKey = null;
	let matches = 0;
	for (const k of Object.keys(pending)) if ((pending[k].fingerprint ?? "") === input.fingerprint) {
		matches++;
		matchKey = k;
		if (matches > 1) return null;
	}
	if (matches !== 1 || !matchKey) return null;
	const entry = pending[matchKey];
	const finalEntry = {
		originalCanonical: entry.originalCanonical,
		originalPath: entry.originalPath ?? null,
		messageId: entry.messageId ?? null
	};
	finals[finalEntryKey(input.trashUidValidity, input.trashUid)] = finalEntry;
	saveFinal(storage, input.accountId, kind, finals);
	delete pending[matchKey];
	savePending(storage, input.accountId, kind, pending);
	return finalEntry;
}
//#endregion
//#region node_modules/.nitro/vite/services/ssr/assets/mail-Da1BT2cd.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var DropdownMenu = Root2;
var DropdownMenuTrigger = Trigger;
var DropdownMenuSubTrigger = import_react.forwardRef(({ className, inset, children, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SubTrigger2, {
	ref,
	className: cn("flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[state=open]:bg-accent [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0", inset && "pl-8", className),
	...props,
	children: [children, /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronRight, { className: "ml-auto" })]
}));
DropdownMenuSubTrigger.displayName = SubTrigger2.displayName;
var DropdownMenuSubContent = import_react.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SubContent2, {
	ref,
	className: cn("z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-dropdown-menu-content-transform-origin)", className),
	...props
}));
DropdownMenuSubContent.displayName = SubContent2.displayName;
var DropdownMenuContent = import_react.forwardRef(({ className, sideOffset = 4, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Portal2, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Content2, {
	ref,
	sideOffset,
	className: cn("z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md", "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-dropdown-menu-content-transform-origin)", className),
	...props
}) }));
DropdownMenuContent.displayName = Content2.displayName;
var DropdownMenuItem = import_react.forwardRef(({ className, inset, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Item2, {
	ref,
	className: cn("relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0", inset && "pl-8", className),
	...props
}));
DropdownMenuItem.displayName = Item2.displayName;
var DropdownMenuCheckboxItem = import_react.forwardRef(({ className, children, checked, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(CheckboxItem2, {
	ref,
	className: cn("relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className),
	checked,
	...props,
	children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: "absolute left-2 flex h-3.5 w-3.5 items-center justify-center",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ItemIndicator2, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "h-4 w-4" }) })
	}), children]
}));
DropdownMenuCheckboxItem.displayName = CheckboxItem2.displayName;
var DropdownMenuRadioItem = import_react.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(RadioItem2, {
	ref,
	className: cn("relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className),
	...props,
	children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: "absolute left-2 flex h-3.5 w-3.5 items-center justify-center",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ItemIndicator2, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Circle, { className: "h-2 w-2 fill-current" }) })
	}), children]
}));
DropdownMenuRadioItem.displayName = RadioItem2.displayName;
var DropdownMenuLabel = import_react.forwardRef(({ className, inset, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Label2, {
	ref,
	className: cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className),
	...props
}));
DropdownMenuLabel.displayName = Label2.displayName;
var DropdownMenuSeparator = import_react.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Separator2, {
	ref,
	className: cn("-mx-1 my-1 h-px bg-muted", className),
	...props
}));
DropdownMenuSeparator.displayName = Separator2.displayName;
var DropdownMenuShortcut = ({ className, ...props }) => {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: cn("ml-auto text-xs tracking-widest opacity-60", className),
		...props
	});
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";
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
createServerFn({ method: "POST" }).inputValidator((v) => AuthSchema.parse(v)).handler(createSsrRpc("327ac5ac0e1714e9f50eb91753d07bf9895efb632982a12c238ef299c3ef508d"));
var bridgeGetFolderCounts = createServerFn({ method: "POST" }).inputValidator((v) => AuthSchema.parse(v)).handler(createSsrRpc("e5583fdf5640d377ae78898feeb5b3b128d34e3c1b64a2e726a8a530edb73efc"));
var bridgeGetMessages = createServerFn({ method: "POST" }).inputValidator((v) => FolderPayloadSchema.parse(v)).handler(createSsrRpc("6c499f2027a99a2541fe81c79775983aa1121e19daac7bb30efeb60724a68ce2"));
/**
* Typed fetch-message code. Callers use it to distinguish a proven-absent
* message (`NOT_FOUND` — the bridge received HTTP 404 or explicit null) from
* transient failures (`NETWORK`, `UNKNOWN`, etc). Only `NOT_FOUND` is a safe
* signal to tombstone the local index row; every other code is preserved
* verbatim so the UI never invents a ghost cleanup.
*/
var bridgeGetMessage = createServerFn({ method: "POST" }).inputValidator((v) => MessagePayloadSchema.parse(v)).handler(createSsrRpc("470e587b8f39a2eae6f2921521b05513dc06c1a1e18d9ec774287e953d1d3632"));
var bridgeMarkRead = createServerFn({ method: "POST" }).inputValidator((v) => MarkReadPayloadSchema.parse(v)).handler(createSsrRpc("e5f6a899687d0f7becc1aa5a6509ec7f3ed92bf56edb2a1b42dcb421fa7aea89"));
var bridgeStar = createServerFn({ method: "POST" }).inputValidator((v) => StarPayloadSchema.parse(v)).handler(createSsrRpc("e0c9f33b894f16849029ea602f0d79a6497ebca59de1257211c34d655aa8c966"));
/**
* Bridge move-result contract (mirror of MoveResult in bridge/src/imap.ts).
* `uidMappingAvailable === true` guarantees a real `destinationUid` from
* an IMAP UIDPLUS COPYUID response — never invent one on the client.
*/
var bridgeMove = createServerFn({ method: "POST" }).inputValidator((v) => MovePayloadSchema.parse(v)).handler(createSsrRpc("59077837af02770e500b75c1ba19c2ee3d51a9684072f6e64732a3110224a1bb"));
var bridgeDelete = createServerFn({ method: "POST" }).inputValidator((v) => MessagePayloadSchema.parse(v)).handler(createSsrRpc("32db5cdba53eee787a6f7fe1dae32fc98931be298323bd1ceb5529de7a377064"));
var bridgeSearch = createServerFn({ method: "POST" }).inputValidator((v) => SearchPayloadSchema.parse(v)).handler(createSsrRpc("9d96f6f53a1b6dd76d3ec63208231f848583d83be1adc6cc36cd4ee3dd6fd762"));
createServerFn({ method: "POST" }).inputValidator((v) => SendPayloadSchema.parse(v)).handler(createSsrRpc("ea4b5b84770708bac663897582735c6885a66527eea00e5bae50e8be35b4806d"));
var InputSchema$6 = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	canonical: enumType([
		"inbox",
		"starred",
		"sent",
		"drafts",
		"spam",
		"trash",
		"archive"
	]),
	uid: numberType().int().positive(),
	/**
	* Trusted by the server ONLY for observability + strict scoping. The
	* writer scopes the tombstone update to the folder row resolved by
	* (accountId, companyId, canonical), which is the authoritative
	* identity. `uidvalidity` mismatch here is treated as a "no match"
	* (idempotent no-op) and never decrements counters.
	*/
	uidvalidity: numberType().int().positive().optional()
}).strict();
var tombstoneGhostMessage = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema$6.parse(v)).handler(createSsrRpc("b7af3d175c6f1270c274f8b9d0e1b299aeb8350b1583ffbc335e7d134529d077"));
var InputSchema$5 = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	canonical: enumType([
		"inbox",
		"starred",
		"sent",
		"drafts",
		"spam",
		"trash",
		"archive",
		"all"
	]),
	limit: numberType().int().positive().max(200).default(50),
	cursor: stringType().min(1).max(2048).optional()
}).strict();
var indexListMessages = createServerFn({ method: "POST" }).inputValidator((input) => InputSchema$5.parse(input)).handler(createSsrRpc("a1985f859cc5bc1e0b9e353f558f7d9a34fc2937e905f76e70f92c7b3e928f83"));
var InputSchema$4 = objectType({ mailSessionToken: stringType().min(20).max(4096) }).strict();
var indexListFolderCounts = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema$4.parse(v)).handler(createSsrRpc("10dfd7142f5adadcb59aa793ba2100c77efe52d0f07feaf12561f06a6e85d912"));
var CanonicalSchema$1 = enumType([
	"inbox",
	"starred",
	"sent",
	"drafts",
	"spam",
	"trash",
	"archive",
	"all"
]);
var InputSchema$3 = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	password: stringType().min(1).max(1024),
	canonical: CanonicalSchema$1,
	uid: numberType().int().positive(),
	kind: enumType(["seen", "flagged"]),
	value: booleanType()
}).strict();
var indexUpdateFlag = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema$3.parse(v)).handler(createSsrRpc("3b6f2b9b4961ae54be116abbeaac1d639b00c2e0fbec888022f7870e0c699858"));
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
var InputSchema$2 = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	password: stringType().min(1).max(1024),
	sourceCanonical: CanonicalSchema,
	destCanonical: CanonicalSchema,
	uid: numberType().int().positive()
}).strict();
var indexMoveMessage = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema$2.parse(v)).handler(createSsrRpc("07e077ac8b4a008c14da044a9e626ad59ce8b84691dca326efc520011a484a2c"));
var InputSchema$1 = objectType({
	mailSessionToken: stringType().min(20).max(4096),
	password: stringType().min(1).max(1024),
	canonical: literalType("trash"),
	uid: numberType().int().positive()
}).strict();
var indexDeleteMessage = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema$1.parse(v)).handler(createSsrRpc("301bf68a4f567a9e734abfdcac1afaf0bafd91f3350b015b3c702ab471260262"));
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
var runMailSync = createServerFn({ method: "POST" }).inputValidator((input) => InputSchema.parse(input)).handler(createSsrRpc("acdd37ebda76688b0815318aa8dd7bd40f42721d320b2ef20860693ffdf22fa4"));
var DEFAULT_INCREMENTAL_MS = 45e3;
var DEFAULT_RECONCILE_MS = 5 * 6e4;
function hasMeaningfulChange(res) {
	return res.mode === "initial" || res.wipedForUidValidity || res.wroteMessages > 0 || res.appliedFlagChanges > 0 || res.tombstoned > 0;
}
function useMailIndexSync(args) {
	const { session, folderPath, canonical, indexed, onSynced, intervalMs = DEFAULT_INCREMENTAL_MS, reconcileMs = DEFAULT_RECONCILE_MS, enabled = true } = args;
	const sync = useServerFn(runMailSync);
	const inflightRef = (0, import_react.useRef)(null);
	const didInitialRef = (0, import_react.useRef)(indexed);
	const flagsNeedReconcileRef = (0, import_react.useRef)(false);
	const lastReconcileAtRef = (0, import_react.useRef)(0);
	const paramsRef = (0, import_react.useRef)({
		session,
		folderPath,
		canonical,
		enabled
	});
	const onSyncedRef = (0, import_react.useRef)(onSynced);
	const indexedRef = (0, import_react.useRef)(indexed);
	const bootstrappedKeyRef = (0, import_react.useRef)("");
	(0, import_react.useEffect)(() => {
		paramsRef.current = {
			session,
			folderPath,
			canonical,
			enabled
		};
	}, [
		session,
		folderPath,
		canonical,
		enabled
	]);
	(0, import_react.useEffect)(() => {
		onSyncedRef.current = onSynced;
	}, [onSynced]);
	(0, import_react.useEffect)(() => {
		indexedRef.current = indexed;
		if (indexed) didInitialRef.current = true;
	}, [indexed]);
	const runOnce = (0, import_react.useCallback)(async (mode, opts) => {
		const p = paramsRef.current;
		if (!p.enabled) return;
		const token = p.session?.mailSessionToken;
		const password = p.session?.password;
		if (!token || !password || !p.folderPath || !p.canonical) return;
		if (mode === "reconcile" && !didInitialRef.current) return;
		if (inflightRef.current) return;
		const call = sync({ data: {
			mailSessionToken: token,
			password,
			folderPath: p.folderPath,
			canonical: p.canonical,
			mode
		} }).then((res) => {
			if (res.ok && "busy" in res && res.busy === false) {
				if (mode === "initial") didInitialRef.current = true;
				if (mode === "reconcile") {
					lastReconcileAtRef.current = Date.now();
					flagsNeedReconcileRef.current = false;
				}
				if (res.flagsSync === "reconcile-required") flagsNeedReconcileRef.current = true;
				if (!opts?.suppressOnSynced && hasMeaningfulChange(res)) onSyncedRef.current?.(res);
			}
		}).catch(() => {}).finally(() => {
			inflightRef.current = null;
		});
		inflightRef.current = call;
		await call;
	}, [sync]);
	(0, import_react.useEffect)(() => {
		if (!enabled) return;
		const token = session?.mailSessionToken;
		if (!token || !session?.password || !folderPath || !canonical) return;
		let cancelled = false;
		let incrementalTimer = null;
		let reconcileTimer = null;
		const isVisible = () => typeof document === "undefined" || !document.hidden;
		const bootstrapKey = `${token}|${folderPath}|${canonical}`;
		const isFirstBootstrap = bootstrappedKeyRef.current !== bootstrapKey;
		if (isFirstBootstrap) {
			bootstrappedKeyRef.current = bootstrapKey;
			didInitialRef.current = indexedRef.current;
			flagsNeedReconcileRef.current = false;
			lastReconcileAtRef.current = 0;
		}
		function scheduleIncremental() {
			if (cancelled) return;
			incrementalTimer = setTimeout(async () => {
				if (!isVisible()) {
					scheduleIncremental();
					return;
				}
				await runOnce(didInitialRef.current ? "incremental" : "initial");
				scheduleIncremental();
			}, intervalMs);
		}
		function scheduleReconcile() {
			if (cancelled) return;
			reconcileTimer = setTimeout(async () => {
				if (!isVisible() || !didInitialRef.current) {
					scheduleReconcile();
					return;
				}
				await runOnce("reconcile");
				scheduleReconcile();
			}, reconcileMs);
		}
		if (isFirstBootstrap) runOnce(didInitialRef.current ? "incremental" : "initial").then(() => {
			scheduleIncremental();
			scheduleReconcile();
		});
		else {
			scheduleIncremental();
			scheduleReconcile();
		}
		return () => {
			cancelled = true;
			if (incrementalTimer) clearTimeout(incrementalTimer);
			if (reconcileTimer) clearTimeout(reconcileTimer);
		};
	}, [`${session?.mailSessionToken || ""}|${folderPath || ""}|${canonical || ""}|${enabled ? "1" : "0"}|${intervalMs}|${reconcileMs}`]);
	return {
		reconcileNow: (0, import_react.useCallback)((opts) => runOnce("reconcile", opts), [runOnce]),
		incrementalNow: (0, import_react.useCallback)((opts) => runOnce(didInitialRef.current ? "incremental" : "initial", opts), [runOnce]),
		shouldReconcile: (0, import_react.useCallback)(() => {
			if (!didInitialRef.current) return false;
			if (flagsNeedReconcileRef.current) return true;
			if (lastReconcileAtRef.current === 0) return true;
			return Date.now() - lastReconcileAtRef.current >= reconcileMs;
		}, [reconcileMs])
	};
}
/**
* Unified flag identity (V4).
*
* "Starred" is a virtual IMAP view over INBOX filtered by `\Flagged`. The
* physical row is the same as `inbox:<uid>`. Flag overrides must therefore
* be keyed by the PHYSICAL identity so a Star/Read toggle applied inside
* one view is reflected in the other without depending on a reload or
* background sync.
*
* Hidden-ids (row suppression) still key by the ORIGINAL view id, because
* hiding is a per-view concern (only the Starred list drops rows on unstar).
*/
function normalizeFlagIdentity(id) {
	const colonIdx = id.indexOf(":");
	if (colonIdx <= 0) return id;
	if (id.slice(0, colonIdx) !== "starred") return id;
	const uidStr = id.slice(colonIdx + 1);
	if (!uidStr || !/^\d+$/.test(uidStr)) return id;
	return `inbox:${uidStr}`;
}
/** Apply overrides to a list (pure — returns a new array). */
function applyOverrides(list, overrides) {
	if (overrides.size === 0) return list;
	return list.map((m) => applyOverrideToOne(m, overrides));
}
/** Apply overrides to a single message (pure). */
function applyOverrideToOne(m, overrides) {
	const o = overrides.get(normalizeFlagIdentity(m.id));
	if (!o) return m;
	if (o.starred === void 0 && o.read === void 0) return m;
	return {
		...m,
		...o.starred !== void 0 ? { starred: o.starred } : {},
		...o.read !== void 0 ? { read: o.read } : {}
	};
}
/** Set (or merge) an override entry. Mutates the map in place. */
function setOverride(overrides, id, patch) {
	const key = normalizeFlagIdentity(id);
	const existing = overrides.get(key) ?? {};
	overrides.set(key, {
		...existing,
		...patch
	});
	return overrides;
}
/** Clear a single field; drop the entry when empty. */
function clearOverrideField(overrides, id, field) {
	const key = normalizeFlagIdentity(id);
	const existing = overrides.get(key);
	if (!existing) return;
	const next = { ...existing };
	delete next[field];
	if (next.starred === void 0 && next.read === void 0) overrides.delete(key);
	else overrides.set(key, next);
}
/** Clear the whole entry (used on mutation failure rollback). */
function clearOverride(overrides, id) {
	overrides.delete(normalizeFlagIdentity(id));
}
/**
* GC pass: drop override fields where the incoming raw row already matches
* the expected value. Safe to call on every server-list arrival — no-op if
* there is drift, keeping the override until the server catches up.
* Mutates `overrides` in place.
*/
function reconcileOverrides(list, overrides) {
	if (overrides.size === 0) return;
	for (const m of list) {
		const key = normalizeFlagIdentity(m.id);
		const o = overrides.get(key);
		if (!o) continue;
		if (o.starred !== void 0 && m.starred === o.starred) clearOverrideField(overrides, key, "starred");
		if (o.read !== void 0 && m.read === o.read) clearOverrideField(overrides, key, "read");
	}
}
function hiddenHas(hidden, id) {
	return hidden.has(id);
}
function applyHidden(list, hidden) {
	if (hidden.size === 0) return list;
	return list.filter((m) => !hiddenHas(hidden, m.id));
}
/** Mark an id as hidden (mutation in flight). Idempotent. */
function hideId(hidden, id) {
	if (hidden instanceof Set) {
		hidden.add(id);
		return;
	}
	hidden.set(id, { status: "pending" });
}
/** Drop the hide entirely (rollback OR re-star flow). */
function unhideId(hidden, id) {
	hidden.delete(id);
}
/**
* Mark a hide as confirmed at `confirmedAt`. It stays active until a list
* load started AFTER `confirmedAt` completes; `gcHiddenBefore` then drops it.
*/
function confirmHide(hidden, id, confirmedAt) {
	hidden.set(id, {
		status: "confirmed",
		confirmedAt
	});
}
/**
* Drop every confirmed entry whose `confirmedAt <= cutoff`. Pending entries
* are always retained (their mutation hasn't finished yet).
*
* Call this AFTER a successful primary list load, passing the timestamp
* captured BEFORE the load was issued. Any hide confirmed before that
* timestamp is guaranteed to be reflected by this list — safe to drop.
* Returns the number of entries removed (for tests).
*/
function gcHiddenBefore(hidden, cutoff) {
	if (hidden.size === 0) return 0;
	let removed = 0;
	for (const [id, entry] of hidden) if (entry.status === "confirmed" && entry.confirmedAt <= cutoff) {
		hidden.delete(id);
		removed++;
	}
	return removed;
}
async function runManualRefresh(deps) {
	await deps.incrementalNow({ suppressOnSynced: true });
	await Promise.all([deps.loadMessages(), deps.loadCounts()]);
	if (deps.shouldReconcile()) (deps.scheduleBackground ?? ((fn) => {
		Promise.resolve().then(fn);
	}))(() => {
		queueMicrotask(() => {
			deps.reconcileNow({ suppressOnSynced: true });
		});
	});
}
function createSingleFlight() {
	let inFlight = null;
	function run(fn) {
		if (inFlight) return inFlight;
		const p = fn().finally(() => {
			inFlight = null;
		});
		inFlight = p;
		return p;
	}
	function isBusy() {
		return inFlight !== null;
	}
	return {
		run,
		isBusy
	};
}
/** Re-insert `original` into `list` at `originalIndex`, skipping duplicates. */
function reviveAt(list, original, originalIndex) {
	if (list.some((m) => m.id === original.id)) return list.slice();
	const next = list.slice();
	const insertAt = Math.min(Math.max(originalIndex, 0), next.length);
	next.splice(insertAt, 0, original);
	return next;
}
var now = Date.now();
var hoursAgo = (h) => (/* @__PURE__ */ new Date(now - h * 36e5)).toISOString();
var daysAgo = (d) => (/* @__PURE__ */ new Date(now - d * 864e5)).toISOString();
var senders = [
	{
		name: "أحمد الغامدي",
		email: "ahmed@aramco.com"
	},
	{
		name: "Sarah Chen",
		email: "sarah.chen@stripe.com"
	},
	{
		name: "Google Cloud",
		email: "no-reply@cloud.google.com"
	},
	{
		name: "GitHub",
		email: "noreply@github.com"
	},
	{
		name: "فاطمة القحطاني",
		email: "fatima@stc.com.sa"
	},
	{
		name: "Linear",
		email: "team@linear.app"
	},
	{
		name: "Notion",
		email: "team@notion.so"
	},
	{
		name: "خالد السلطان",
		email: "khaled@moi.gov.sa"
	},
	{
		name: "Vercel",
		email: "invoice+statements@vercel.com"
	},
	{
		name: "AWS Billing",
		email: "no-reply@aws.amazon.com"
	}
];
var subjects = [
	"اجتماع الغد — مراجعة استراتيجية الربع الثاني",
	"Your Stripe payment has been received",
	"Google Cloud: New security recommendation for your project",
	"[mailmaestro/mail] Pull request #142 needs your review",
	"عرض شراكة جديد — يرجى المراجعة",
	"Weekly digest: 12 issues updated in your projects",
	"New page shared: Q1 2026 Product Roadmap",
	"دعوة رسمية لحضور المؤتمر السنوي",
	"Your December 2025 invoice is ready",
	"AWS billing alert: forecasted charges exceeded threshold",
	"تحديث المشروع — المرحلة الأولى مكتملة ✅",
	"Design review — new dashboard mockups attached"
];
var bodies = [
	"<p>مرحباً،</p><p>أود التذكير باجتماع الغد الساعة 10:00 صباحاً لمراجعة استراتيجية الربع الثاني. سيتم مناقشة النقاط التالية:</p><ul><li>أهداف المبيعات</li><li>خطة التوسع الإقليمي</li><li>الميزانية التقديرية</li></ul><p>مع خالص التقدير،<br/>أحمد</p>",
	"<p>Hi,</p><p>Your payment of <strong>$1,250.00</strong> has been successfully processed. Thank you for your business.</p><p>View invoice → </p><p>— The Stripe Team</p>",
	"<p>We detected a new security recommendation for your project. Please review at your earliest convenience.</p>",
	"<p>A new pull request is ready for your review. Please take a look when you have a moment.</p>",
	"<p>السلام عليكم،</p><p>يسرّنا التواصل معكم بخصوص فرصة شراكة استراتيجية. نرفق طيّاً المستند الأولي للمراجعة.</p>"
];
var words = [
	"مرحباً بكم في تحديث هذا الأسبوع",
	"Please review the attached document at your earliest convenience",
	"تم إرسال طلبكم بنجاح وسيتم المعالجة قريباً",
	"Meeting scheduled for tomorrow at 10 AM sharp",
	"نتشرّف بدعوتكم لحضور الحدث السنوي"
];
var folders = [
	"inbox",
	"inbox",
	"inbox",
	"inbox",
	"inbox",
	"inbox",
	"sent",
	"drafts"
];
var MOCK_MESSAGES = Array.from({ length: 24 }, (_, i) => {
	const sender = senders[i % senders.length];
	const folder = folders[i % folders.length];
	const hasAttach = i % 4 === 0;
	return {
		id: `msg_${i + 1}`,
		threadId: `thread_${i + 1}`,
		folder,
		from: sender,
		to: [{
			name: "أنت",
			email: "me@company.com"
		}],
		subject: subjects[i % subjects.length],
		preview: words[i % words.length],
		body: bodies[i % bodies.length],
		date: i < 3 ? hoursAgo(i + 1) : i < 8 ? hoursAgo(i * 3) : daysAgo(Math.floor(i / 3)),
		read: i > 5,
		starred: i % 5 === 0,
		hasAttachments: hasAttach,
		attachments: hasAttach ? [{
			id: `att_${i}`,
			filename: i % 2 === 0 ? "تقرير_الربع_الأول.pdf" : "Q1_Report.pdf",
			size: 245e3 + i * 12e3,
			mimeType: "application/pdf"
		}] : void 0,
		labels: i % 3 === 0 ? ["مهم"] : void 0
	};
});
function getFolderCounts() {
	return [
		"inbox",
		"starred",
		"sent",
		"drafts",
		"spam",
		"trash",
		"archive"
	].map((folder) => {
		const items = MOCK_MESSAGES.filter((m) => folder === "starred" ? m.starred : m.folder === folder);
		return {
			folder,
			total: items.length,
			unread: items.filter((m) => !m.read).length
		};
	});
}
function getMessages(folder = "inbox") {
	return [...folder === "starred" ? MOCK_MESSAGES.filter((m) => m.starred) : folder === "all" ? MOCK_MESSAGES : MOCK_MESSAGES.filter((m) => m.folder === folder)].sort((a, b) => a.date < b.date ? 1 : -1);
}
function getMessage(id) {
	return MOCK_MESSAGES.find((m) => m.id === id);
}
function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatDate(iso) {
	const d = new Date(iso);
	const now = /* @__PURE__ */ new Date();
	if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("ar-SA", {
		hour: "2-digit",
		minute: "2-digit"
	});
	if (Math.floor((now.getTime() - d.getTime()) / 864e5) < 7 && d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("ar-SA", { weekday: "short" });
	if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("ar-SA", {
		day: "numeric",
		month: "short"
	});
	return d.toLocaleDateString("en-GB", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric"
	});
}
/** Normalize a folder name to the physical IMAP mailbox identity. */
function normalizePhysicalFolder(folder) {
	if (!folder) return "";
	return folder === "starred" ? "inbox" : folder;
}
/** Composite key for a single physical row. */
function pendingMoveKey(accountId, physicalSourceFolder, sourceUid) {
	return `${accountId}\u0000${normalizePhysicalFolder(physicalSourceFolder)}\u0000${sourceUid}`;
}
/** Parse a MailMessage id (`folder:uid`) into its physical identity parts. */
function parsePhysicalIdentity(messageId) {
	const colon = messageId.indexOf(":");
	if (colon <= 0) return null;
	const folder = messageId.slice(0, colon);
	const uidStr = messageId.slice(colon + 1);
	if (!uidStr || !/^\d+$/.test(uidStr)) return null;
	const uid = Number(uidStr);
	if (!Number.isFinite(uid) || uid <= 0) return null;
	return {
		physicalFolder: normalizePhysicalFolder(folder),
		uid
	};
}
/** Enter a `pending` entry. Idempotent per identity: replaces any prior entry. */
function beginPendingMove(entries, input) {
	const physicalSourceFolder = normalizePhysicalFolder(input.sourceFolder);
	const entry = {
		accountId: input.accountId,
		physicalSourceFolder,
		sourceUid: input.sourceUid,
		sourceUidValidity: input.sourceUidValidity,
		messageId: input.messageId ?? null,
		status: "pending",
		startedAt: input.now ?? Date.now(),
		operation: input.operation
	};
	entries.set(pendingMoveKey(input.accountId, physicalSourceFolder, input.sourceUid), entry);
	return entry;
}
/** IMAP-success confirmation. The entry stays until a source-read reconciles it. */
function confirmPendingMove(entries, input) {
	const key = pendingMoveKey(input.accountId, input.sourceFolder, input.sourceUid);
	const cur = entries.get(key);
	if (!cur) return null;
	const next = {
		...cur,
		status: "confirmed",
		confirmedAt: input.now ?? Date.now(),
		sourceConfirmation: input.sourceConfirmation ?? cur.sourceConfirmation
	};
	entries.set(key, next);
	return next;
}
/** IMAP-failure rollback: drop the entry so the row can re-appear. */
function rollbackPendingMove(entries, input) {
	return entries.delete(pendingMoveKey(input.accountId, input.sourceFolder, input.sourceUid));
}
/** Drop every entry belonging to `accountId` (used on logout / account switch). */
function clearPendingMovesForAccount(entries, accountId) {
	let removed = 0;
	for (const [k, e] of entries) if (e.accountId === accountId) {
		entries.delete(k);
		removed++;
	}
	return removed;
}
/**
* Return true if `messageId` (folder:uid) is currently suppressed by any
* pending-move entry for `accountId`. Destination-folder rows are NOT
* suppressed because they resolve to a different physical folder than the
* entry's source folder — matching is keyed on the source folder only.
*/
function isMessageSuppressed(entries, accountId, messageId) {
	if (entries.size === 0) return false;
	const parsed = parsePhysicalIdentity(messageId);
	if (!parsed) return false;
	return entries.has(pendingMoveKey(accountId, parsed.physicalFolder, parsed.uid));
}
/** Apply the overlay to a list of messages (pure — returns a new array). */
function applyPendingMoveOverlay(list, entries, accountId) {
	if (!accountId || entries.size === 0) return list;
	return list.filter((m) => !isMessageSuppressed(entries, accountId, m.id));
}
/**
* GC pass with strict rules (BLOCKER_3):
*   * Only touches entries whose (accountId + physicalSourceFolder) matches
*     the request scope. A Trash/Archive load never GC's an Inbox entry.
*   * Only drops `confirmed` entries whose `confirmedAt` is strictly older
*     than `requestStartedAt` (the list started AFTER confirmation).
*   * Only drops entries whose source UID is NOT present in the raw list.
*     If the source UID is still there (e.g. `still-present` from IMAP,
*     racing pre-mutation response, etc.) the entry stays.
* Returns the number of entries removed (for tests).
*/
function reconcilePendingMovesAfterSourceRead(entries, input) {
	if (entries.size === 0) return 0;
	const scopeFolder = normalizePhysicalFolder(input.physicalSourceFolder);
	const scopeAccount = input.accountId;
	const presentUids = /* @__PURE__ */ new Set();
	for (const m of input.rawList) {
		const p = parsePhysicalIdentity(m.id);
		if (!p) continue;
		if (p.physicalFolder !== scopeFolder) continue;
		presentUids.add(p.uid);
	}
	let removed = 0;
	for (const [k, e] of entries) {
		if (e.accountId !== scopeAccount) continue;
		if (e.physicalSourceFolder !== scopeFolder) continue;
		if (e.status !== "confirmed") continue;
		if (e.confirmedAt == null) continue;
		if (!(input.requestStartedAt > e.confirmedAt)) continue;
		if (presentUids.has(e.sourceUid)) continue;
		entries.delete(k);
		removed++;
	}
	return removed;
}
var STORAGE_KEY = "mailmaestro.pending-moves.v1";
function serializePendingMoves(entries) {
	return JSON.stringify(Array.from(entries.values()));
}
function deserializePendingMoves(raw) {
	const map = /* @__PURE__ */ new Map();
	if (!raw) return map;
	try {
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return map;
		for (const e of arr) {
			if (!e || typeof e.accountId !== "string" || typeof e.physicalSourceFolder !== "string" || typeof e.sourceUid !== "number") continue;
			map.set(pendingMoveKey(e.accountId, e.physicalSourceFolder, e.sourceUid), {
				...e,
				physicalSourceFolder: normalizePhysicalFolder(e.physicalSourceFolder)
			});
		}
	} catch {}
	return map;
}
function loadPendingMovesFromSession() {
	if (typeof sessionStorage === "undefined") return /* @__PURE__ */ new Map();
	return deserializePendingMoves(sessionStorage.getItem(STORAGE_KEY));
}
function savePendingMovesToSession(entries) {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.setItem(STORAGE_KEY, serializePendingMoves(entries));
	} catch {}
}
function sanitizeEmailHtml(html) {
	if (!html) return "";
	return purify.sanitize(html, {
		FORBID_TAGS: [
			"script",
			"iframe",
			"object",
			"embed",
			"form",
			"link",
			"meta",
			"base",
			"style"
		],
		FORBID_ATTR: [
			"style",
			"srcdoc",
			"formaction"
		],
		ALLOW_DATA_ATTR: false
	}).replace(/<a\s/gi, "<a target=\"_blank\" rel=\"noopener noreferrer nofollow\" ");
}
var FOLDER_META = {
	inbox: {
		label: "الوارد",
		icon: Inbox
	},
	starred: {
		label: "المميّزة",
		icon: Star
	},
	sent: {
		label: "المرسلة",
		icon: Send
	},
	drafts: {
		label: "المسودّات",
		icon: FileText
	},
	spam: {
		label: "المزعجة",
		icon: OctagonAlert
	},
	trash: {
		label: "المهملات",
		icon: Trash2
	},
	archive: {
		label: "الأرشيف",
		icon: Archive
	},
	all: {
		label: "الكل",
		icon: Mail
	}
};
function parseMessageId(id) {
	const [folder, uidStr] = id.split(":");
	const uid = Number(uidStr);
	if (!folder || !uidStr || Number.isNaN(uid)) return null;
	return {
		folder,
		uid
	};
}
function safeOriginStorage() {
	if (typeof localStorage === "undefined") return {
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {}
	};
	return localStorage;
}
/** Extract trash identity from a successful move result, if available. */
function extractTrashIdentity(result) {
	if (!result || !result.ok) return null;
	if (result.move.uidMappingAvailable && typeof result.move.destinationUid === "number" && result.move.destinationUidValidity) {
		const uv = Number(result.move.destinationUidValidity);
		if (Number.isFinite(uv) && uv > 0) return {
			trashUidValidity: uv,
			trashUid: result.move.destinationUid
		};
	}
	if (typeof result.discoveredDestinationUid === "number") {
		const uv = result.discoveredDestinationUidValidity ? Number(result.discoveredDestinationUidValidity) : NaN;
		if (Number.isFinite(uv) && uv > 0) return {
			trashUidValidity: uv,
			trashUid: result.discoveredDestinationUid
		};
	}
	return null;
}
/** Build a fingerprint from a MailMessage-like row. */
function fingerprintFromMessage(m) {
	return buildOriginFingerprint({
		messageId: m.threadId ?? null,
		fromEmail: m.from?.email ?? null,
		subject: m.subject ?? null,
		date: m.date ?? null
	});
}
/**
* Return the OriginKind we track when the destination is `dest`, or null
* for destinations that have no restore semantics (inbox/sent/drafts/spam/all).
*/
function originKindForDestination(dest) {
	if (dest === "trash") return "trash";
	if (dest === "archive") return "archive";
	return null;
}
/** Return the OriginKind for a source folder that CAN be restored. */
function originKindForRestore(source) {
	if (source === "trash") return "trash";
	if (source === "archive") return "archive";
	return null;
}
/**
* Write origin after a successful move to Trash OR Archive (final or pending).
* `destKind` scopes the namespace so Trash and Archive origins can never
* collide even when both destinations expose the same (UID, UIDVALIDITY).
*/
function writeOriginOnDestination(params) {
	const { accountId, destKind, sourceCanonical, sourceUid, sourceUidValidity, messageId, fingerprint, moveResult } = params;
	if (!accountId || sourceCanonical === destKind) return;
	const storage = safeOriginStorage();
	const dest = extractTrashIdentity(moveResult);
	if (dest) {
		rememberFinalOrigin(storage, {
			accountId,
			trashUidValidity: dest.trashUidValidity,
			trashUid: dest.trashUid
		}, {
			originalCanonical: sourceCanonical,
			messageId: messageId ?? null
		}, destKind);
		forgetPendingOrigin(storage, {
			accountId,
			sourceCanonical,
			sourceUid,
			sourceUidValidity
		}, destKind);
	} else rememberPendingOrigin(storage, {
		accountId,
		sourceCanonical,
		sourceUid,
		sourceUidValidity
	}, {
		originalCanonical: sourceCanonical,
		messageId: messageId ?? null,
		fingerprint: fingerprint ?? null,
		createdAt: Date.now()
	}, destKind);
}
/** Read the origin for a destination uid (Trash or Archive). Defaults to "inbox". */
function readOriginForDestUid(kind, accountId, destUid, destUidValidity) {
	if (!accountId || destUidValidity == null) return "inbox";
	return getOrigin(safeOriginStorage(), {
		accountId,
		trashUidValidity: destUidValidity,
		trashUid: destUid
	}, kind)?.originalCanonical ?? "inbox";
}
/**
* Forget the FINAL origin entry for one physical destination row (Trash or
* Archive). Never touches other entries and never touches Pending entries.
*/
function forgetOriginForDestUid(kind, accountId, destUid, destUidValidity) {
	if (!accountId || destUidValidity == null) return;
	forgetFinalOrigin(safeOriginStorage(), {
		accountId,
		trashUidValidity: destUidValidity,
		trashUid: destUid
	}, kind);
}
/**
* After a destination list arrives (from Index or Bridge), promote any
* UNIQUE pending origin whose fingerprint matches a newly-visible row in
* that destination. Ambiguous matches are ignored.
*/
function promotePendingOriginsForDestList(kind, accountId, destUidValidity, messages) {
	if (!accountId || destUidValidity == null) return;
	const storage = safeOriginStorage();
	for (const m of messages) {
		const parsed = parseMessageId(m.id);
		if (!parsed || parsed.folder !== kind) continue;
		const fp = fingerprintFromMessage(m);
		if (!fp) continue;
		promoteUniquePendingOriginForTrashMessage(storage, {
			accountId,
			trashUidValidity: destUidValidity,
			trashUid: parsed.uid,
			fingerprint: fp
		}, kind);
	}
}
function stripHtml(html) {
	if (!html) return "";
	if (typeof document === "undefined") return html.replace(/<[^>]+>/g, "");
	const tmp = document.createElement("div");
	tmp.innerHTML = html;
	return tmp.textContent || tmp.innerText || "";
}
function quoteBody(message) {
	const src = stripHtml(message.body || message.preview || "");
	return `\n\n\nOn ${new Date(message.date).toLocaleString("ar", {
		dateStyle: "medium",
		timeStyle: "short"
	})}, ${message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email} wrote:\n` + src.split("\n").map((l) => `> ${l}`).join("\n");
}
function buildReply(message, myEmail, all) {
	const subject = message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`;
	const to = message.from.email;
	let cc = "";
	if (all) {
		const others = [...message.to.map((a) => a.email), ...message.cc?.map((a) => a.email) ?? []].filter((e) => e && e.toLowerCase() !== myEmail.toLowerCase() && e.toLowerCase() !== to.toLowerCase());
		cc = Array.from(new Set(others)).join(", ");
	}
	return {
		to,
		cc,
		subject,
		body: quoteBody(message)
	};
}
function buildForward(message) {
	return {
		to: "",
		subject: message.subject.startsWith("Fwd:") ? message.subject : `Fwd: ${message.subject}`,
		body: `\n\n---------- Forwarded message ----------\nFrom: ${message.from.name} <${message.from.email}>\nDate: ${new Date(message.date).toLocaleString("ar")}\nSubject: ${message.subject}\nTo: ${message.to.map((t) => t.email).join(", ")}\n\n` + stripHtml(message.body || message.preview || "")
	};
}
function useMailData(session) {
	const getCounts = useServerFn(bridgeGetFolderCounts);
	const getMessages$1 = useServerFn(bridgeGetMessages);
	const listIndex = useServerFn(indexListMessages);
	const listIndexCounts = useServerFn(indexListFolderCounts);
	const [folder, setFolder] = (0, import_react.useState)("inbox");
	const [sort, setSort] = (0, import_react.useState)("date-desc");
	const [counts, setCounts] = (0, import_react.useState)({
		inbox: {
			total: 0,
			unread: 0,
			supported: true
		},
		starred: {
			total: 0,
			unread: 0,
			supported: true
		},
		sent: {
			total: 0,
			unread: 0,
			supported: true
		},
		drafts: {
			total: 0,
			unread: 0,
			supported: true
		},
		spam: {
			total: 0,
			unread: 0,
			supported: true
		},
		trash: {
			total: 0,
			unread: 0,
			supported: true
		},
		archive: {
			total: 0,
			unread: 0,
			supported: true
		},
		all: {
			total: 0,
			unread: 0,
			supported: true
		}
	});
	const [folderPaths, setFolderPaths] = (0, import_react.useState)({});
	const [messages, setMessages] = (0, import_react.useState)([]);
	const [loading, setLoading] = (0, import_react.useState)(false);
	const [loadingMore, setLoadingMore] = (0, import_react.useState)(false);
	const [hasMore, setHasMore] = (0, import_react.useState)(false);
	const [bridgeError, setBridgeError] = (0, import_react.useState)(null);
	const [useMock, setUseMock] = (0, import_react.useState)(false);
	const [source, setSource] = (0, import_react.useState)("bridge");
	const [indexCursor, setIndexCursor] = (0, import_react.useState)(null);
	const [indexReady, setIndexReady] = (0, import_react.useState)({});
	const loadReqIdRef = (0, import_react.useRef)(0);
	const PAGE = 50;
	const pendingOverridesRef = (0, import_react.useRef)(/* @__PURE__ */ new Map());
	const pendingHiddenRef = (0, import_react.useRef)(/* @__PURE__ */ new Map());
	const pendingMovesRef = (0, import_react.useRef)(loadPendingMovesFromSession());
	const persistPendingMoves = (0, import_react.useCallback)(() => {
		savePendingMovesToSession(pendingMovesRef.current);
	}, []);
	const trashUidValidityRef = (0, import_react.useRef)(null);
	const archiveUidValidityRef = (0, import_react.useRef)(null);
	const countsMutationGen = (0, import_react.useRef)(0);
	const bumpCountsGen = (0, import_react.useCallback)(() => {
		countsMutationGen.current += 1;
	}, []);
	const pendingStarMutRef = (0, import_react.useRef)({
		active: 0,
		settledAt: 0
	});
	const STAR_COUNT_HOT_MS = 2e3;
	const isStarCountHot = (0, import_react.useCallback)(() => {
		const s = pendingStarMutRef.current;
		return s.active > 0 || Date.now() - s.settledAt < STAR_COUNT_HOT_MS;
	}, []);
	const currentAccountId = session?.account.id ?? null;
	/** Apply overrides + hidden filter + pending-move overlay, GC confirmed entries. */
	const applyPending = (0, import_react.useCallback)((list) => {
		reconcileOverrides(list, pendingOverridesRef.current);
		return applyPendingMoveOverlay(applyHidden(applyOverrides(list, pendingOverridesRef.current), pendingHiddenRef.current), pendingMovesRef.current, currentAccountId);
	}, [currentAccountId]);
	/** Wrap a single incoming message the same way (used by messageCache). */
	const applyPendingOne = (0, import_react.useCallback)((m) => applyOverrideToOne(m, pendingOverridesRef.current), []);
	/**
	* Reconcile pending-move entries whose source folder was just read. MUST
	* be called with the RAW (pre-overlay) server list so presence checks are
	* accurate. Only touches (accountId + physical source folder) matching
	* the read scope — a Trash read never GC's an Inbox overlay entry.
	*/
	const reconcilePendingMovesForRead = (0, import_react.useCallback)((rawList, canonical, startedAt) => {
		if (!currentAccountId || pendingMovesRef.current.size === 0) return;
		if (reconcilePendingMovesAfterSourceRead(pendingMovesRef.current, {
			accountId: currentAccountId,
			physicalSourceFolder: normalizePhysicalFolder(canonical),
			requestStartedAt: startedAt,
			rawList
		}) > 0) persistPendingMoves();
	}, [currentAccountId, persistPendingMoves]);
	const lastAccountIdRef = (0, import_react.useRef)(currentAccountId);
	(0, import_react.useEffect)(() => {
		const prev = lastAccountIdRef.current;
		lastAccountIdRef.current = currentAccountId;
		if (prev && prev !== currentAccountId) {
			clearPendingMovesForAccount(pendingMovesRef.current, prev);
			persistPendingMoves();
		}
	}, [currentAccountId, persistPendingMoves]);
	const folderPath = folderPaths[folder] ?? null;
	const loadCounts = (0, import_react.useCallback)(async () => {
		if (!session) return;
		const gen = countsMutationGen.current;
		try {
			const result = await getCounts({ data: {
				mailSessionToken: session.mailSessionToken ?? "",
				password: session.password
			} });
			if (countsMutationGen.current !== gen) return;
			const map = {
				inbox: {
					total: 0,
					unread: 0,
					supported: true
				},
				starred: {
					total: 0,
					unread: 0,
					supported: true
				},
				sent: {
					total: 0,
					unread: 0,
					supported: true
				},
				drafts: {
					total: 0,
					unread: 0,
					supported: true
				},
				spam: {
					total: 0,
					unread: 0,
					supported: true
				},
				trash: {
					total: 0,
					unread: 0,
					supported: true
				},
				archive: {
					total: 0,
					unread: 0,
					supported: false
				},
				all: {
					total: 0,
					unread: 0,
					supported: false
				}
			};
			if (!result.ok) throw new Error(result.error);
			const paths = {};
			result.counts.forEach((c) => {
				map[c.folder] = {
					total: c.total,
					unread: c.unread,
					supported: c.supported !== false
				};
				if (c.path) paths[c.folder] = c.path;
			});
			setCounts((prev) => {
				if (isStarCountHot() && prev.starred) map.starred = {
					...map.starred,
					total: prev.starred.total
				};
				return map;
			});
			setFolderPaths(paths);
			setBridgeError(null);
		} catch (err) {
			if (countsMutationGen.current !== gen) return;
			setBridgeError(err?.message || "فشل الاتصال بخادم البريد");
			setCounts(Object.fromEntries(getFolderCounts().map((c) => [c.folder, {
				total: c.total,
				unread: c.unread,
				supported: true
			}])));
		}
	}, [
		session,
		getCounts,
		isStarCountHot
	]);
	/**
	* Manual-Refresh counts path: prefer Local Mail Index (single Supabase
	* SELECT, no IMAP round-trip). Falls back to the bridge only when the
	* index has not yet resolved for this account/session. Also refreshes
	* `folderPaths` from any bridge fallback path — the index never invents
	* new paths.
	*/
	const loadCountsFast = (0, import_react.useCallback)(async () => {
		if (!session) return;
		const gen = countsMutationGen.current;
		if (session.mailSessionToken) try {
			const res = await listIndexCounts({ data: { mailSessionToken: session.mailSessionToken } });
			if (countsMutationGen.current !== gen) return;
			if (res.ok && res.counts.length > 0) {
				setCounts((prev) => {
					const next = { ...prev };
					for (const c of res.counts) {
						if (!c.hasUidvalidity) continue;
						if (c.folder === "starred" && isStarCountHot() && prev.starred) {
							const cur = next.starred ?? {
								total: 0,
								unread: 0,
								supported: true
							};
							next.starred = {
								total: prev.starred.total,
								unread: c.unread,
								supported: cur.supported
							};
							continue;
						}
						const cur = next[c.folder] ?? {
							total: 0,
							unread: 0,
							supported: true
						};
						next[c.folder] = {
							total: c.total,
							unread: c.unread,
							supported: cur.supported
						};
					}
					return next;
				});
				setFolderPaths((prev) => {
					let changed = false;
					const next = { ...prev };
					for (const c of res.counts) if (c.path && next[c.folder] !== c.path) {
						next[c.folder] = c.path;
						changed = true;
					}
					return changed ? next : prev;
				});
				setBridgeError(null);
				const nextTrashUV = res.counts.find((c) => c.folder === "trash")?.uidvalidity ?? null;
				if (nextTrashUV != null && trashUidValidityRef.current !== nextTrashUV && currentAccountId) purgeStaleTrashUidValidity(safeOriginStorage(), currentAccountId, nextTrashUV);
				trashUidValidityRef.current = nextTrashUV;
				return;
			}
		} catch {}
		await loadCounts();
	}, [
		session,
		listIndexCounts,
		loadCounts,
		isStarCountHot
	]);
	const canUseIndex = (0, import_react.useCallback)((f, s) => s === "date-desc" && !!session?.mailSessionToken && !!folderPaths[f] && f !== "starred", [session, folderPaths]);
	const loadFromBridge = (0, import_react.useCallback)(async (reqId) => {
		if (!session) return;
		const bridgeStartedAt = Date.now();
		try {
			const result = await getMessages$1({ data: {
				mailSessionToken: session.mailSessionToken ?? "",
				password: session.password,
				folder,
				limit: PAGE,
				offset: 0,
				sort
			} });
			if (loadReqIdRef.current !== reqId) return;
			if (!result.ok) throw new Error(result.error);
			reconcilePendingMovesForRead(result.messages, folder, bridgeStartedAt);
			const promoteKind = originKindForRestore(folder);
			if (promoteKind) promotePendingOriginsForDestList(promoteKind, currentAccountId, promoteKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current, result.messages);
			setMessages(applyPending(result.messages));
			setHasMore(result.messages.length >= PAGE);
			setBridgeError(null);
			setUseMock(false);
			setSource("bridge");
			setIndexCursor(null);
		} catch (err) {
			if (loadReqIdRef.current !== reqId) return;
			setBridgeError(err?.message || "فشل جلب الرسائل");
			setMessages(applyPending(getMessages(folder)));
			setHasMore(false);
			setUseMock(true);
			setSource("mock");
			setIndexCursor(null);
		}
	}, [
		session,
		folder,
		sort,
		getMessages$1,
		applyPending,
		reconcilePendingMovesForRead
	]);
	const loadMessages = (0, import_react.useCallback)(async () => {
		if (!session) return;
		const reqId = ++loadReqIdRef.current;
		const startedAt = Date.now();
		setLoading(true);
		try {
			if (canUseIndex(folder, sort)) try {
				const res = await listIndex({ data: {
					mailSessionToken: session.mailSessionToken,
					canonical: folder,
					limit: PAGE
				} });
				if (loadReqIdRef.current !== reqId) return;
				if (res.ok && res.indexed) {
					reconcilePendingMovesForRead(res.messages, folder, startedAt);
					const promoteKind = originKindForRestore(folder);
					if (promoteKind) promotePendingOriginsForDestList(promoteKind, currentAccountId, promoteKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current, res.messages);
					setMessages(applyPending(res.messages));
					setHasMore(res.hasMore);
					setIndexCursor(res.nextCursor);
					setSource("index");
					setUseMock(false);
					setBridgeError(null);
					setIndexReady((prev) => prev[folder] ? prev : {
						...prev,
						[folder]: true
					});
					gcHiddenBefore(pendingHiddenRef.current, startedAt);
					return;
				}
				setIndexReady((prev) => prev[folder] === false ? prev : {
					...prev,
					[folder]: false
				});
			} catch {
				setIndexReady((prev) => prev[folder] === false ? prev : {
					...prev,
					[folder]: false
				});
			}
			await loadFromBridge(reqId);
			if (loadReqIdRef.current === reqId) gcHiddenBefore(pendingHiddenRef.current, startedAt);
		} finally {
			if (loadReqIdRef.current === reqId) setLoading(false);
		}
	}, [
		session,
		folder,
		sort,
		canUseIndex,
		listIndex,
		loadFromBridge,
		applyPending
	]);
	const loadMore = (0, import_react.useCallback)(async () => {
		if (!session || loadingMore || loading || !hasMore) return;
		setLoadingMore(true);
		try {
			if (source === "index" && indexCursor && canUseIndex(folder, sort)) {
				const res = await listIndex({ data: {
					mailSessionToken: session.mailSessionToken,
					canonical: folder,
					limit: PAGE,
					cursor: indexCursor
				} });
				if (res.ok && res.indexed) {
					const patched = applyPending(res.messages);
					setMessages((prev) => {
						const seen = new Set(prev.map((m) => m.id));
						const merged = [...prev];
						for (const m of patched) if (!seen.has(m.id)) merged.push(m);
						return merged;
					});
					setHasMore(res.hasMore);
					setIndexCursor(res.nextCursor);
					return;
				}
				setHasMore(false);
				return;
			}
			const offset = messages.length;
			const result = await getMessages$1({ data: {
				mailSessionToken: session.mailSessionToken ?? "",
				password: session.password,
				folder,
				limit: PAGE,
				offset,
				sort
			} });
			if (!result.ok) throw new Error(result.error);
			const patched = applyPending(result.messages);
			setMessages((prev) => {
				const seen = new Set(prev.map((m) => m.id));
				const merged = [...prev];
				for (const m of patched) if (!seen.has(m.id)) merged.push(m);
				return merged;
			});
			setHasMore(result.messages.length >= PAGE);
		} catch {
			setHasMore(false);
		} finally {
			setLoadingMore(false);
		}
	}, [
		session,
		folder,
		sort,
		getMessages$1,
		listIndex,
		messages.length,
		loadingMore,
		loading,
		hasMore,
		source,
		indexCursor,
		canUseIndex
	]);
	(0, import_react.useEffect)(() => {
		loadCounts();
	}, [loadCounts]);
	(0, import_react.useEffect)(() => {
		loadMessages();
	}, [loadMessages]);
	(0, import_react.useEffect)(() => {
		setSort("date-desc");
	}, [folder]);
	const { reconcileNow, incrementalNow, shouldReconcile } = useMailIndexSync({
		session,
		folderPath,
		canonical: folder,
		indexed: indexReady[folder] === true,
		enabled: !!session?.mailSessionToken && sort === "date-desc" && folder !== "starred",
		onSynced: () => {
			loadMessages();
			loadCountsFast();
		}
	});
	return {
		folder,
		setFolder,
		sort,
		setSort,
		counts,
		setCounts,
		messages,
		setMessages,
		loading,
		loadingMore,
		hasMore,
		loadMore,
		bridgeError,
		useMock,
		loadCounts,
		source,
		/**
		* Manual Refresh contract (locked by tests):
		*   incrementalNow=1, list=1, counts=1 (via loadCountsFast → Local Index),
		*   reconcileNow is NEVER awaited on the manual path. When it's due,
		*   scheduleBackground fires it after the spinner has already ended.
		*/
		refresh: () => runManualRefresh({
			incrementalNow,
			reconcileNow,
			shouldReconcile,
			loadMessages,
			loadCounts: loadCountsFast
		}),
		onAfterSend: async () => {
			if (folder === "sent") {
				await incrementalNow({ suppressOnSynced: true });
				await Promise.all([loadMessages(), loadCountsFast()]);
			} else await loadCountsFast();
		},
		pendingOverridesRef,
		setPendingFlagOverride: (id, patch) => {
			bumpCountsGen();
			setOverride(pendingOverridesRef.current, id, patch);
		},
		clearPendingFlagOverride: (id, field) => {
			if (field) clearOverrideField(pendingOverridesRef.current, id, field);
			else clearOverride(pendingOverridesRef.current, id);
		},
		hideRow: (id) => hideId(pendingHiddenRef.current, id),
		unhideRow: (id) => unhideId(pendingHiddenRef.current, id),
		confirmHideRow: (id, at = Date.now()) => confirmHide(pendingHiddenRef.current, id, at),
		beginPendingMove: (id, operation) => {
			if (!currentAccountId) return;
			const parsed = parseMessageId(id);
			if (!parsed) return;
			bumpCountsGen();
			beginPendingMove(pendingMovesRef.current, {
				accountId: currentAccountId,
				sourceFolder: parsed.folder,
				sourceUid: parsed.uid,
				messageId: id,
				operation
			});
			persistPendingMoves();
		},
		confirmPendingMove: (id) => {
			if (!currentAccountId) return;
			const parsed = parseMessageId(id);
			if (!parsed) return;
			bumpCountsGen();
			confirmPendingMove(pendingMovesRef.current, {
				accountId: currentAccountId,
				sourceFolder: parsed.folder,
				sourceUid: parsed.uid
			});
			persistPendingMoves();
		},
		rollbackPendingMove: (id) => {
			if (!currentAccountId) return;
			const parsed = parseMessageId(id);
			if (!parsed) return;
			bumpCountsGen();
			rollbackPendingMove(pendingMovesRef.current, {
				accountId: currentAccountId,
				sourceFolder: parsed.folder,
				sourceUid: parsed.uid
			});
			persistPendingMoves();
		},
		clearAllPendingMoves: () => {
			if (!currentAccountId) return;
			if (clearPendingMovesForAccount(pendingMovesRef.current, currentAccountId) > 0) persistPendingMoves();
		},
		beginStarMutation: () => {
			bumpCountsGen();
			pendingStarMutRef.current.active++;
		},
		endStarMutation: () => {
			const s = pendingStarMutRef.current;
			if (s.active > 0) s.active--;
			s.settledAt = Date.now();
		},
		applyPending,
		applyPendingOne,
		pendingMovesRef,
		trashUidValidityRef,
		archiveUidValidityRef,
		bumpCountsGen
	};
}
function MailApp() {
	const navigate = useNavigate();
	const { confirm } = useConfirm();
	const [session, setSession] = (0, import_react.useState)(void 0);
	const [selectedId, setSelectedId] = (0, import_react.useState)(null);
	const [query, setQuery] = (0, import_react.useState)("");
	const [sidebarOpen, setSidebarOpen] = (0, import_react.useState)(false);
	const [compose, setCompose] = (0, import_react.useState)(null);
	const [selectedMessage, setSelectedMessage] = (0, import_react.useState)(null);
	const [reading, setReading] = (0, import_react.useState)(false);
	const [selection, setSelection] = (0, import_react.useState)(() => /* @__PURE__ */ new Set());
	const [bulkBusy, setBulkBusy] = (0, import_react.useState)(false);
	const [selectMode, setSelectMode] = (0, import_react.useState)(false);
	const [refreshing, setRefreshing] = (0, import_react.useState)(false);
	const [searchMode, setSearchMode] = (0, import_react.useState)("quick");
	const [deepIncludeBody, setDeepIncludeBody] = (0, import_react.useState)(false);
	const [deepResults, setDeepResults] = (0, import_react.useState)(null);
	const [deepLoading, setDeepLoading] = (0, import_react.useState)(false);
	const [deepError, setDeepError] = (0, import_react.useState)(null);
	const { folder, setFolder, sort, setSort, counts, setCounts, messages, setMessages, loading, loadingMore, hasMore, loadMore, bridgeError, useMock, loadCounts, refresh: rawRefresh, onAfterSend, setPendingFlagOverride, clearPendingFlagOverride, hideRow, unhideRow, confirmHideRow, beginPendingMove, confirmPendingMove, rollbackPendingMove, clearAllPendingMoves, beginStarMutation, endStarMutation, applyPending, applyPendingOne, pendingMovesRef, trashUidValidityRef, archiveUidValidityRef, bumpCountsGen } = useMailData(session || null);
	const currentAccountId = session?.account.id ?? null;
	const refreshFlightRef = (0, import_react.useRef)(createSingleFlight());
	const refresh = (0, import_react.useCallback)(() => {
		if (refreshFlightRef.current.isBusy()) return refreshFlightRef.current.run(() => Promise.resolve());
		setRefreshing(true);
		return refreshFlightRef.current.run(async () => {
			try {
				await rawRefresh();
			} finally {
				setRefreshing(false);
			}
		});
	}, [rawRefresh]);
	const getOne = useServerFn(bridgeGetMessage);
	const cleanupGhost = useServerFn(tombstoneGhostMessage);
	const markRead = useServerFn(bridgeMarkRead);
	const star = useServerFn(bridgeStar);
	const updateFlag = useServerFn(indexUpdateFlag);
	const move = useServerFn(bridgeMove);
	const deleteFn = useServerFn(bridgeDelete);
	const moveIndex = useServerFn(indexMoveMessage);
	const deleteIndex = useServerFn(indexDeleteMessage);
	const searchFn = useServerFn(bridgeSearch);
	const mutateFlag = (0, import_react.useCallback)(async (canonical, uid, kind, value) => {
		if (!session) throw new Error("لا توجد جلسة بريد");
		if (session.mailSessionToken) {
			const res = await updateFlag({ data: {
				mailSessionToken: session.mailSessionToken,
				password: session.password,
				canonical,
				uid,
				kind,
				value
			} });
			if (!res.ok) throw new Error(res.error);
			return;
		}
		if (kind === "seen") await markRead({ data: {
			mailSessionToken: session.mailSessionToken ?? "",
			password: session.password,
			folder: canonical,
			uid,
			read: value
		} });
		else await star({ data: {
			mailSessionToken: session.mailSessionToken ?? "",
			password: session.password,
			folder: canonical,
			uid,
			starred: value
		} });
	}, [
		session,
		updateFlag,
		markRead,
		star
	]);
	const mutateMoveOrDelete = (0, import_react.useCallback)(async (params) => {
		if (!session) throw new Error("لا توجد جلسة بريد");
		const dest = params.toFolder;
		if (dest === void 0) {
			if (params.sourceCanonical !== "trash") throw new Error("الحذف النهائي مسموح فقط من مجلد المهملات");
			if (session.mailSessionToken) {
				const res = await deleteIndex({ data: {
					mailSessionToken: session.mailSessionToken,
					password: session.password,
					canonical: "trash",
					uid: params.uid
				} });
				if (!res.ok) throw new Error(res.error);
				return null;
			}
			await deleteFn({ data: {
				mailSessionToken: session.mailSessionToken ?? "",
				password: session.password,
				folder: params.sourceCanonical,
				uid: params.uid
			} });
			return null;
		}
		if (session.mailSessionToken) {
			const res = await moveIndex({ data: {
				mailSessionToken: session.mailSessionToken,
				password: session.password,
				sourceCanonical: params.sourceCanonical,
				destCanonical: dest,
				uid: params.uid
			} });
			if (!res.ok) throw new Error(res.error);
			return res;
		}
		await move({ data: {
			mailSessionToken: session.mailSessionToken ?? "",
			password: session.password,
			folder: params.sourceCanonical,
			uid: params.uid,
			toFolder: dest
		} });
		return null;
	}, [
		session,
		moveIndex,
		deleteIndex,
		deleteFn,
		move
	]);
	const moveFlightRef = (0, import_react.useRef)(/* @__PURE__ */ new Map());
	const runMoveFlight = (0, import_react.useCallback)(async (id, worker) => {
		const existing = moveFlightRef.current.get(id);
		if (existing) return existing;
		const p = worker().finally(() => {
			moveFlightRef.current.delete(id);
		});
		moveFlightRef.current.set(id, p);
		return p;
	}, []);
	const messageCache = (0, import_react.useRef)(/* @__PURE__ */ new Map());
	const inflight = (0, import_react.useRef)(/* @__PURE__ */ new Map());
	const fetchMessage = (0, import_react.useCallback)((id) => {
		if (!session) return Promise.resolve(null);
		const accountId = currentAccountId;
		if (accountId && isMessageSuppressed(pendingMovesRef.current, accountId, id)) return Promise.resolve(null);
		const cached = messageCache.current.get(id);
		if (cached) return Promise.resolve(cached);
		const existing = inflight.current.get(id);
		if (existing) return existing;
		const parsed = parseMessageId(id);
		if (!parsed) return Promise.resolve(null);
		const p = getOne({ data: {
			mailSessionToken: session.mailSessionToken ?? "",
			password: session.password,
			folder: parsed.folder,
			uid: parsed.uid
		} }).then((result) => {
			if (result.ok && result.message) {
				const acc = currentAccountId;
				if (acc && isMessageSuppressed(pendingMovesRef.current, acc, id)) return null;
				const patched = applyPendingOne(result.message);
				messageCache.current.set(id, patched);
				return patched;
			}
			if (!result.ok && result.code === "NOT_FOUND") {
				if (parsed.folder !== "all") cleanupGhost({ data: {
					mailSessionToken: session.mailSessionToken ?? "",
					canonical: parsed.folder,
					uid: parsed.uid
				} }).catch(() => {});
				messageCache.current.delete(id);
				setMessages((prev) => prev.filter((m) => m.id !== id));
				hideRow(id);
				setSelectedId((cur) => cur === id ? null : cur);
				setSelectedMessage((cur) => cur && cur.id === id ? null : cur);
				toast.info("تم إزالة رسالة مفقودة من القائمة");
				return null;
			}
			return null;
		}).catch(() => null).finally(() => {
			inflight.current.delete(id);
		});
		inflight.current.set(id, p);
		return p;
	}, [
		session,
		getOne,
		applyPendingOne,
		currentAccountId,
		cleanupGhost
	]);
	const prefetchMessage = (0, import_react.useCallback)((id) => {
		const accountId = currentAccountId;
		if (accountId && isMessageSuppressed(pendingMovesRef.current, accountId, id)) return;
		if (!messageCache.current.has(id) && !inflight.current.has(id)) fetchMessage(id);
	}, [fetchMessage, currentAccountId]);
	useCompanyTheme(session?.company ? {
		primary: session.company.brand_primary,
		accent: session.company.brand_accent
	} : {
		primary: "#0F172A",
		accent: "#3B82F6"
	});
	(0, import_react.useEffect)(() => {
		const s = getMailSession();
		if (!s) {
			navigate({ to: "/login" });
			return;
		}
		setSession(s);
	}, [navigate]);
	(0, import_react.useEffect)(() => {
		messageCache.current.clear();
		inflight.current.clear();
		setSelection(/* @__PURE__ */ new Set());
		setSelectMode(false);
	}, [folder]);
	(0, import_react.useEffect)(() => {
		setDeepResults(null);
		setDeepError(null);
	}, [folder, searchMode]);
	(0, import_react.useEffect)(() => {
		if (searchMode !== "deep" || !session) return;
		const q = query.trim();
		if (q.length < 2) {
			setDeepResults(null);
			setDeepError(null);
			setDeepLoading(false);
			return;
		}
		let cancelled = false;
		setDeepLoading(true);
		setDeepError(null);
		const t = setTimeout(async () => {
			try {
				const res = await searchFn({ data: {
					mailSessionToken: session.mailSessionToken ?? "",
					password: session.password,
					folder,
					query: q,
					includeBody: deepIncludeBody,
					limit: 100
				} });
				if (cancelled) return;
				if (res.ok) setDeepResults(applyPending(res.messages));
				else {
					setDeepResults([]);
					setDeepError(res.error || "فشل البحث على السيرفر");
				}
			} catch (err) {
				if (!cancelled) {
					setDeepResults([]);
					setDeepError(err?.message || "فشل البحث على السيرفر");
				}
			} finally {
				if (!cancelled) setDeepLoading(false);
			}
		}, 400);
		return () => {
			cancelled = true;
			clearTimeout(t);
		};
	}, [
		query,
		searchMode,
		deepIncludeBody,
		folder,
		session,
		searchFn
	]);
	const filteredMessages = (0, import_react.useMemo)(() => {
		if (searchMode === "deep" && query.trim().length >= 2) return deepResults ?? [];
		if (!query.trim()) return messages;
		const q = query.toLowerCase();
		return messages.filter((m) => m.subject.toLowerCase().includes(q) || m.from.name.toLowerCase().includes(q) || m.from.email.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q));
	}, [
		messages,
		query,
		searchMode,
		deepResults
	]);
	const inDeepSearch = searchMode === "deep" && query.trim().length >= 2;
	async function openMessage(id) {
		setSelectedId(id);
		const parsed = parseMessageId(id);
		if (!parsed || !session) {
			setSelectedMessage(getMessage(id) ?? null);
			return;
		}
		const cached = messageCache.current.get(id);
		if (cached) {
			setSelectedMessage(cached);
			setReading(false);
		} else {
			setSelectedMessage(null);
			setReading(true);
		}
		try {
			const msg = await fetchMessage(id);
			if (msg) setSelectedMessage(msg);
			else if (!cached) throw new Error("فشل فتح الرسالة");
			const listMsg = messages.find((m) => m.id === id);
			if (listMsg && !listMsg.read) {
				setPendingFlagOverride(id, { read: true });
				setMessages((prev) => prev.map((m) => m.id === id ? {
					...m,
					read: true
				} : m));
				setCounts((prev) => {
					const cur = prev[parsed.folder];
					if (!cur || cur.unread <= 0) return prev;
					return {
						...prev,
						[parsed.folder]: {
							...cur,
							unread: cur.unread - 1
						}
					};
				});
				const c = messageCache.current.get(id);
				if (c) messageCache.current.set(id, {
					...c,
					read: true
				});
				mutateFlag(parsed.folder, parsed.uid, "seen", true).catch(() => {
					clearPendingFlagOverride(id, "read");
				});
			}
		} catch (err) {
			if (!cached) {
				toast.error(err?.message || "فشل فتح الرسالة");
				setSelectedMessage(getMessage(id) ?? null);
			}
		} finally {
			setReading(false);
		}
	}
	async function toggleStar(e, id) {
		e.stopPropagation();
		const parsed = parseMessageId(id);
		if (!parsed || !session) return;
		const nextStarred = !(searchMode === "deep" && query.trim().length >= 2 && deepResults ? deepResults : messages).find((m) => m.id === id)?.starred;
		setPendingFlagOverride(id, { starred: nextStarred });
		beginStarMutation();
		setCounts((prev) => {
			const cur = prev.starred;
			if (!cur) return prev;
			const delta = nextStarred ? 1 : -1;
			return {
				...prev,
				starred: {
					...cur,
					total: Math.max(0, cur.total + delta)
				}
			};
		});
		let starredFolderSnapshot = null;
		if (folder === "starred" && !nextStarred) {
			const idx = messages.findIndex((m) => m.id === id);
			if (idx >= 0) {
				starredFolderSnapshot = {
					list: messages,
					index: idx
				};
				hideRow(id);
				setMessages((prev) => prev.filter((m) => m.id !== id));
			}
		} else {
			unhideRow(id);
			if (parsed.folder !== "starred") unhideRow(`starred:${parsed.uid}`);
			setMessages((prev) => prev.map((m) => m.id === id ? {
				...m,
				starred: nextStarred
			} : m));
		}
		setDeepResults((prev) => prev ? prev.map((m) => m.id === id ? {
			...m,
			starred: nextStarred
		} : m) : prev);
		const cached = messageCache.current.get(id);
		if (cached) messageCache.current.set(id, {
			...cached,
			starred: nextStarred
		});
		try {
			await mutateFlag(parsed.folder, parsed.uid, "flagged", nextStarred);
			if (starredFolderSnapshot) confirmHideRow(id, Date.now());
		} catch (err) {
			clearPendingFlagOverride(id, "starred");
			setCounts((prev) => {
				const cur = prev.starred;
				if (!cur) return prev;
				const delta = nextStarred ? -1 : 1;
				return {
					...prev,
					starred: {
						...cur,
						total: Math.max(0, cur.total + delta)
					}
				};
			});
			if (starredFolderSnapshot) {
				unhideRow(id);
				const { list, index } = starredFolderSnapshot;
				const revived = list[index];
				setMessages((prev) => {
					if (prev.some((m) => m.id === id)) return prev;
					const next = prev.slice();
					const clampedIdx = Math.min(index, next.length);
					next.splice(clampedIdx, 0, revived);
					return next;
				});
			} else setMessages((prev) => prev.map((m) => m.id === id ? {
				...m,
				starred: !nextStarred
			} : m));
			setDeepResults((prev) => prev ? prev.map((m) => m.id === id ? {
				...m,
				starred: !nextStarred
			} : m) : prev);
			const c = messageCache.current.get(id);
			if (c) messageCache.current.set(id, {
				...c,
				starred: !nextStarred
			});
			toast.error(err?.message || "فشل تحديث المميّز");
		} finally {
			endStarMutation();
		}
	}
	async function toggleRead(e, id) {
		e.stopPropagation();
		const parsed = parseMessageId(id);
		if (!parsed || !session) return;
		const msg = messages.find((m) => m.id === id);
		if (!msg) return;
		const nextRead = !msg.read;
		setPendingFlagOverride(id, { read: nextRead });
		setMessages((prev) => prev.map((m) => m.id === id ? {
			...m,
			read: nextRead
		} : m));
		setDeepResults((prev) => prev ? prev.map((m) => m.id === id ? {
			...m,
			read: nextRead
		} : m) : prev);
		const cached = messageCache.current.get(id);
		if (cached) messageCache.current.set(id, {
			...cached,
			read: nextRead
		});
		setCounts((prev) => {
			const cur = prev[parsed.folder];
			if (!cur) return prev;
			const delta = nextRead ? -1 : 1;
			const unread = Math.max(0, cur.unread + delta);
			return {
				...prev,
				[parsed.folder]: {
					...cur,
					unread
				}
			};
		});
		try {
			await mutateFlag(parsed.folder, parsed.uid, "seen", nextRead);
		} catch (err) {
			clearPendingFlagOverride(id, "read");
			setMessages((prev) => prev.map((m) => m.id === id ? {
				...m,
				read: !nextRead
			} : m));
			setDeepResults((prev) => prev ? prev.map((m) => m.id === id ? {
				...m,
				read: !nextRead
			} : m) : prev);
			const c = messageCache.current.get(id);
			if (c) messageCache.current.set(id, {
				...c,
				read: !nextRead
			});
			setCounts((prev) => {
				const cur = prev[parsed.folder];
				if (!cur) return prev;
				const delta = nextRead ? 1 : -1;
				const unread = Math.max(0, cur.unread + delta);
				return {
					...prev,
					[parsed.folder]: {
						...cur,
						unread
					}
				};
			});
			toast.error(err?.message || "فشل تحديث حالة القراءة");
		}
	}
	function applyMoveCountsDelta(from, to, wasUnread) {
		setCounts((prev) => {
			const next = { ...prev };
			const src = next[from];
			if (src) next[from] = {
				...src,
				total: Math.max(0, src.total - 1),
				unread: Math.max(0, src.unread - (wasUnread ? 1 : 0))
			};
			if (to && next[to]) {
				const d = next[to];
				next[to] = {
					...d,
					total: d.total + 1,
					unread: d.unread + (wasUnread ? 1 : 0)
				};
			}
			return next;
		});
	}
	function reviveMessageAt(original, originalIndex) {
		setMessages((prev) => reviveAt(prev, original, originalIndex));
	}
	function reviveDeepResultAt(original, originalIndex) {
		setDeepResults((prev) => prev ? reviveAt(prev, original, originalIndex) : prev);
	}
	async function handleMove(id, toFolder) {
		const parsed = parseMessageId(id);
		if (!parsed || !session) return;
		return runMoveFlight(id, async () => {
			const originalIndex = messages.findIndex((m) => m.id === id);
			const original = originalIndex >= 0 ? messages[originalIndex] : null;
			const wasUnread = original ? !original.read : false;
			const wasSelected = selectedId === id;
			const prevSelected = wasSelected ? selectedMessage : null;
			const cachedBody = messageCache.current.get(id);
			setMessages((prev) => prev.filter((m) => m.id !== id));
			if (wasSelected) {
				setSelectedId(null);
				setSelectedMessage(null);
			}
			messageCache.current.delete(id);
			hideRow(id);
			beginPendingMove(id, toFolder === "trash" ? "trash" : toFolder === "archive" ? "archive" : "move");
			applyMoveCountsDelta(parsed.folder, toFolder, wasUnread);
			try {
				const moveResult = await mutateMoveOrDelete({
					sourceCanonical: parsed.folder,
					uid: parsed.uid,
					toFolder
				});
				const destKind = originKindForDestination(toFolder);
				if (destKind) writeOriginOnDestination({
					accountId: currentAccountId,
					destKind,
					sourceCanonical: parsed.folder,
					sourceUid: parsed.uid,
					messageId: original?.threadId ?? null,
					fingerprint: original ? fingerprintFromMessage(original) : null,
					moveResult
				});
				const srcKind = originKindForRestore(parsed.folder);
				if (srcKind) forgetOriginForDestUid(srcKind, currentAccountId, parsed.uid, srcKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current);
				confirmHideRow(id);
				confirmPendingMove(id);
				toast.success("تم نقل الرسالة");
			} catch (err) {
				unhideRow(id);
				rollbackPendingMove(id);
				applyMoveCountsDelta(toFolder, parsed.folder, wasUnread);
				if (original) reviveMessageAt(original, originalIndex);
				if (cachedBody) messageCache.current.set(id, cachedBody);
				if (wasSelected) {
					setSelectedId(id);
					if (prevSelected) setSelectedMessage(prevSelected);
				}
				toast.error(err?.message || "فشل نقل الرسالة");
			}
		});
	}
	async function handleDelete(id) {
		const parsed = parseMessageId(id);
		if (!parsed || !session) return;
		const isTrash = parsed.folder === "trash";
		if (!await confirm({
			title: isTrash ? "حذف نهائي" : "نقل إلى المهملات",
			description: isTrash ? "هل أنت متأكد من حذف هذه الرسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء." : "هل أنت متأكد من نقل هذه الرسالة إلى المهملات؟",
			confirmLabel: isTrash ? "حذف" : "نقل",
			cancelLabel: "إلغاء",
			variant: isTrash ? "destructive" : "default"
		})) return;
		return runMoveFlight(id, async () => {
			const originalIndex = messages.findIndex((m) => m.id === id);
			const original = originalIndex >= 0 ? messages[originalIndex] : null;
			const wasUnread = original ? !original.read : false;
			const deepOriginalIndex = deepResults ? deepResults.findIndex((m) => m.id === id) : -1;
			const deepOriginal = deepOriginalIndex >= 0 && deepResults ? deepResults[deepOriginalIndex] : null;
			const wasSelected = selectedId === id;
			const prevSelected = wasSelected ? selectedMessage : null;
			const cachedBody = messageCache.current.get(id);
			const destForCounts = isTrash ? null : "trash";
			setMessages((prev) => prev.filter((m) => m.id !== id));
			if (isTrash) setDeepResults((prev) => prev ? prev.filter((m) => m.id !== id) : prev);
			if (wasSelected) {
				setSelectedId(null);
				setSelectedMessage(null);
			}
			messageCache.current.delete(id);
			hideRow(id);
			beginPendingMove(id, isTrash ? "permanent-delete" : "trash");
			applyMoveCountsDelta(parsed.folder, destForCounts, wasUnread);
			try {
				if (isTrash) {
					await mutateMoveOrDelete({
						sourceCanonical: parsed.folder,
						uid: parsed.uid
					});
					forgetOriginForDestUid("trash", currentAccountId, parsed.uid, trashUidValidityRef.current);
				} else {
					const moveResult = await mutateMoveOrDelete({
						sourceCanonical: parsed.folder,
						uid: parsed.uid,
						toFolder: "trash"
					});
					writeOriginOnDestination({
						accountId: currentAccountId,
						destKind: "trash",
						sourceCanonical: parsed.folder,
						sourceUid: parsed.uid,
						messageId: original?.threadId ?? null,
						fingerprint: original ? fingerprintFromMessage(original) : null,
						moveResult
					});
					if (parsed.folder === "archive") forgetOriginForDestUid("archive", currentAccountId, parsed.uid, archiveUidValidityRef.current);
				}
				confirmHideRow(id);
				confirmPendingMove(id);
				toast.success(isTrash ? "تم حذف الرسالة نهائياً" : "تم نقل الرسالة إلى المهملات");
			} catch (err) {
				unhideRow(id);
				rollbackPendingMove(id);
				applyMoveCountsDelta(destForCounts ?? parsed.folder, parsed.folder, wasUnread);
				if (original) reviveMessageAt(original, originalIndex);
				if (isTrash && deepOriginal) reviveDeepResultAt(deepOriginal, deepOriginalIndex);
				if (cachedBody) messageCache.current.set(id, cachedBody);
				if (wasSelected) {
					setSelectedId(id);
					if (prevSelected) setSelectedMessage(prevSelected);
				}
				toast.error(err?.message || (isTrash ? "فشل حذف الرسالة" : "فشل نقل الرسالة إلى المهملات"));
			}
		});
	}
	async function handleRestore(id) {
		const parsed = parseMessageId(id);
		if (!parsed || !session) return;
		const restoreKind = originKindForRestore(parsed.folder);
		if (!restoreKind) return;
		const destUidValidity = restoreKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current;
		return runMoveFlight(id, async () => {
			const originalIndex = messages.findIndex((m) => m.id === id);
			const original = originalIndex >= 0 ? messages[originalIndex] : null;
			const wasUnread = original ? !original.read : false;
			const target = readOriginForDestUid(restoreKind, currentAccountId, parsed.uid, destUidValidity);
			const wasSelected = selectedId === id;
			const prevSelected = wasSelected ? selectedMessage : null;
			const cachedBody = messageCache.current.get(id);
			setMessages((prev) => prev.filter((m) => m.id !== id));
			if (wasSelected) {
				setSelectedId(null);
				setSelectedMessage(null);
			}
			messageCache.current.delete(id);
			hideRow(id);
			beginPendingMove(id, "restore");
			applyMoveCountsDelta(parsed.folder, target, wasUnread);
			try {
				await mutateMoveOrDelete({
					sourceCanonical: parsed.folder,
					uid: parsed.uid,
					toFolder: target
				});
				forgetOriginForDestUid(restoreKind, currentAccountId, parsed.uid, destUidValidity);
				confirmHideRow(id);
				confirmPendingMove(id);
				const label = FOLDER_META[target]?.label || target;
				toast.success(`تم استعادة الرسالة إلى ${label}`);
			} catch (err) {
				unhideRow(id);
				rollbackPendingMove(id);
				applyMoveCountsDelta(target, parsed.folder, wasUnread);
				if (original) reviveMessageAt(original, originalIndex);
				if (cachedBody) messageCache.current.set(id, cachedBody);
				if (wasSelected) {
					setSelectedId(id);
					if (prevSelected) setSelectedMessage(prevSelected);
				}
				toast.error(err?.message || "فشل استعادة الرسالة");
			}
		});
	}
	async function handleMarkUnread(id) {
		const parsed = parseMessageId(id);
		if (!parsed || !session) return;
		const msg = messages.find((m) => m.id === id);
		if (!msg || !msg.read) return;
		const prevSelectedId = selectedId;
		const prevSelected = selectedMessage;
		const prevCache = messageCache.current.get(id);
		setMessages((prev) => prev.map((m) => m.id === id ? {
			...m,
			read: false
		} : m));
		setCounts((prev) => {
			const cur = prev[parsed.folder];
			if (!cur) return prev;
			return {
				...prev,
				[parsed.folder]: {
					...cur,
					unread: cur.unread + 1
				}
			};
		});
		if (prevCache) messageCache.current.set(id, {
			...prevCache,
			read: false
		});
		setSelectedId(null);
		setSelectedMessage(null);
		try {
			await mutateFlag(parsed.folder, parsed.uid, "seen", false);
		} catch (err) {
			setMessages((prev) => prev.map((m) => m.id === id ? {
				...m,
				read: true
			} : m));
			setCounts((prev) => {
				const cur = prev[parsed.folder];
				if (!cur) return prev;
				return {
					...prev,
					[parsed.folder]: {
						...cur,
						unread: Math.max(0, cur.unread - 1)
					}
				};
			});
			if (prevCache) messageCache.current.set(id, prevCache);
			if (prevSelectedId === id) {
				setSelectedId(prevSelectedId);
				setSelectedMessage(prevSelected);
			}
			toast.error(err?.message || "فشل التعليم كغير مقروءة");
		}
	}
	function toggleSelect(id) {
		setSelection((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
	function toggleSelectAllVisible() {
		setSelection((prev) => {
			if (prev.size >= filteredMessages.length && filteredMessages.length > 0) return /* @__PURE__ */ new Set();
			return new Set(filteredMessages.map((m) => m.id));
		});
	}
	function clearSelection() {
		setSelection(/* @__PURE__ */ new Set());
	}
	function toggleSelectMode() {
		setSelectMode((v) => {
			if (v) clearSelection();
			return !v;
		});
	}
	async function runBatch(items, limit, worker) {
		let idx = 0;
		let failed = 0;
		const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (idx < items.length) {
				const i = idx++;
				try {
					await worker(items[i]);
				} catch {
					failed++;
				}
			}
		});
		await Promise.all(runners);
		return { failed };
	}
	function collectBulkMeta(ids) {
		const set = new Set(ids);
		const meta = /* @__PURE__ */ new Map();
		messages.forEach((m, idx) => {
			if (set.has(m.id)) meta.set(m.id, {
				threadId: m.threadId,
				wasUnread: !m.read,
				original: m,
				originalIndex: idx
			});
		});
		return meta;
	}
	async function bulkMove(toFolder) {
		if (!session || selection.size === 0 || bulkBusy) return;
		const ids = Array.from(selection);
		const meta = collectBulkMeta(ids);
		const prevSelectedId = selectedId;
		const prevSelected = selectedMessage;
		const cachedBodies = /* @__PURE__ */ new Map();
		for (const id of ids) {
			const c = messageCache.current.get(id);
			if (c) cachedBodies.set(id, c);
		}
		setBulkBusy(true);
		setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
		if (prevSelectedId && selection.has(prevSelectedId)) {
			setSelectedId(null);
			setSelectedMessage(null);
		}
		const bulkOp = toFolder === "trash" ? "trash" : toFolder === "archive" ? "archive" : "move";
		ids.forEach((id) => {
			messageCache.current.delete(id);
			hideRow(id);
			beginPendingMove(id, bulkOp);
		});
		for (const id of ids) {
			const parsed = parseMessageId(id);
			if (!parsed) continue;
			const info = meta.get(id);
			applyMoveCountsDelta(parsed.folder, toFolder, info?.wasUnread ?? false);
		}
		clearSelection();
		const failedIds = [];
		await runBatch(ids, 5, async (id) => {
			const parsed = parseMessageId(id);
			if (!parsed) return;
			try {
				const moveResult = await mutateMoveOrDelete({
					sourceCanonical: parsed.folder,
					uid: parsed.uid,
					toFolder
				});
				const destKind = originKindForDestination(toFolder);
				if (destKind) writeOriginOnDestination({
					accountId: currentAccountId,
					destKind,
					sourceCanonical: parsed.folder,
					sourceUid: parsed.uid,
					messageId: meta.get(id)?.threadId ?? null,
					fingerprint: (() => {
						const o = meta.get(id)?.original;
						return o ? fingerprintFromMessage(o) : null;
					})(),
					moveResult
				});
				const srcKind = originKindForRestore(parsed.folder);
				if (srcKind) forgetOriginForDestUid(srcKind, currentAccountId, parsed.uid, srcKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current);
				confirmHideRow(id);
				confirmPendingMove(id);
			} catch (err) {
				failedIds.push(id);
				throw err;
			}
		});
		setBulkBusy(false);
		if (failedIds.length > 0) {
			const failedSet = new Set(failedIds);
			for (const id of failedIds) {
				unhideRow(id);
				rollbackPendingMove(id);
				const parsed = parseMessageId(id);
				const info = meta.get(id);
				if (parsed && info) applyMoveCountsDelta(toFolder, parsed.folder, info.wasUnread);
				if (info) reviveMessageAt(info.original, info.originalIndex);
				const cached = cachedBodies.get(id);
				if (cached) messageCache.current.set(id, cached);
			}
			if (prevSelectedId && failedSet.has(prevSelectedId)) {
				setSelectedId(prevSelectedId);
				setSelectedMessage(prevSelected);
			}
			toast.error(`فشل نقل ${failedIds.length} من ${ids.length} رسالة`);
		} else toast.success(`تم نقل ${ids.length} رسالة`);
	}
	async function bulkDelete() {
		if (!session || selection.size === 0 || bulkBusy) return;
		const ids = Array.from(selection);
		const isTrash = folder === "trash";
		if (!await confirm({
			title: isTrash ? "حذف نهائي" : "نقل إلى المهملات",
			description: isTrash ? `هل أنت متأكد من حذف ${ids.length} رسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.` : `هل أنت متأكد من نقل ${ids.length} رسالة إلى المهملات؟`,
			confirmLabel: isTrash ? "حذف" : "نقل",
			cancelLabel: "إلغاء",
			variant: isTrash ? "destructive" : "default"
		})) return;
		const meta = collectBulkMeta(ids);
		const deepMeta = /* @__PURE__ */ new Map();
		if (deepResults) deepResults.forEach((m, idx) => {
			if (idSet.has(m.id)) deepMeta.set(m.id, {
				original: m,
				originalIndex: idx
			});
		});
		const idSet = new Set(ids);
		const prevSelectedId = selectedId;
		const prevSelected = selectedMessage;
		const cachedBodies = /* @__PURE__ */ new Map();
		for (const id of ids) {
			const c = messageCache.current.get(id);
			if (c) cachedBodies.set(id, c);
		}
		setBulkBusy(true);
		setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
		if (isTrash) setDeepResults((prev) => prev ? prev.filter((m) => !idSet.has(m.id)) : prev);
		if (prevSelectedId && selection.has(prevSelectedId)) {
			setSelectedId(null);
			setSelectedMessage(null);
		}
		const bulkDeleteOp = isTrash ? "permanent-delete" : "trash";
		ids.forEach((id) => {
			messageCache.current.delete(id);
			hideRow(id);
			beginPendingMove(id, bulkDeleteOp);
		});
		const destForCounts = isTrash ? null : "trash";
		for (const id of ids) {
			const parsed = parseMessageId(id);
			if (!parsed) continue;
			const info = meta.get(id);
			applyMoveCountsDelta(parsed.folder, destForCounts, info?.wasUnread ?? false);
		}
		clearSelection();
		const failedIds = [];
		await runBatch(ids, 5, async (id) => {
			const parsed = parseMessageId(id);
			if (!parsed) return;
			try {
				if (isTrash) {
					await mutateMoveOrDelete({
						sourceCanonical: parsed.folder,
						uid: parsed.uid
					});
					forgetOriginForDestUid("trash", currentAccountId, parsed.uid, trashUidValidityRef.current);
				} else {
					const moveResult = await mutateMoveOrDelete({
						sourceCanonical: parsed.folder,
						uid: parsed.uid,
						toFolder: "trash"
					});
					writeOriginOnDestination({
						accountId: currentAccountId,
						destKind: "trash",
						sourceCanonical: parsed.folder,
						sourceUid: parsed.uid,
						messageId: meta.get(id)?.threadId ?? null,
						fingerprint: (() => {
							const o = meta.get(id)?.original;
							return o ? fingerprintFromMessage(o) : null;
						})(),
						moveResult
					});
					if (parsed.folder === "archive") forgetOriginForDestUid("archive", currentAccountId, parsed.uid, archiveUidValidityRef.current);
				}
				confirmHideRow(id);
				confirmPendingMove(id);
			} catch (err) {
				failedIds.push(id);
				throw err;
			}
		});
		setBulkBusy(false);
		if (failedIds.length > 0) {
			const failedSet = new Set(failedIds);
			for (const id of failedIds) {
				unhideRow(id);
				rollbackPendingMove(id);
				const parsed = parseMessageId(id);
				const info = meta.get(id);
				if (parsed && info) applyMoveCountsDelta(destForCounts ?? parsed.folder, parsed.folder, info.wasUnread);
				const c = cachedBodies.get(id);
				if (c) messageCache.current.set(id, c);
				if (info) reviveMessageAt(info.original, info.originalIndex);
				if (isTrash) {
					const d = deepMeta.get(id);
					if (d) reviveDeepResultAt(d.original, d.originalIndex);
				}
			}
			if (prevSelectedId && failedSet.has(prevSelectedId)) {
				setSelectedId(prevSelectedId);
				setSelectedMessage(prevSelected);
			}
			toast.error(isTrash ? `فشل حذف ${failedIds.length} من ${ids.length} رسالة` : `فشل نقل ${failedIds.length} من ${ids.length} رسالة إلى المهملات`);
		} else toast.success(isTrash ? `تم حذف ${ids.length} رسالة` : `تم نقل ${ids.length} رسالة إلى المهملات`);
	}
	async function bulkRestore() {
		if (!session || selection.size === 0 || bulkBusy) return;
		const restoreKind = originKindForRestore(folder);
		if (!restoreKind) return;
		const destUidValidity = restoreKind === "trash" ? trashUidValidityRef.current : archiveUidValidityRef.current;
		const ids = Array.from(selection);
		const meta = collectBulkMeta(ids);
		const prevSelectedId = selectedId;
		const prevSelected = selectedMessage;
		const cachedBodies = /* @__PURE__ */ new Map();
		for (const id of ids) {
			const c = messageCache.current.get(id);
			if (c) cachedBodies.set(id, c);
		}
		setBulkBusy(true);
		setMessages((prev) => prev.filter((m) => !selection.has(m.id)));
		if (prevSelectedId && selection.has(prevSelectedId)) {
			setSelectedId(null);
			setSelectedMessage(null);
		}
		ids.forEach((id) => {
			messageCache.current.delete(id);
			hideRow(id);
			beginPendingMove(id, "restore");
		});
		const idToTarget = /* @__PURE__ */ new Map();
		for (const id of ids) {
			const parsed = parseMessageId(id);
			if (!parsed) continue;
			const target = readOriginForDestUid(restoreKind, currentAccountId, parsed.uid, destUidValidity);
			idToTarget.set(id, target);
			applyMoveCountsDelta(parsed.folder, target, meta.get(id)?.wasUnread ?? false);
		}
		clearSelection();
		const failedIds = [];
		await runBatch(ids, 5, async (id) => {
			const parsed = parseMessageId(id);
			if (!parsed) return;
			const target = idToTarget.get(id);
			try {
				await mutateMoveOrDelete({
					sourceCanonical: parsed.folder,
					uid: parsed.uid,
					toFolder: target
				});
				forgetOriginForDestUid(restoreKind, currentAccountId, parsed.uid, destUidValidity);
				confirmHideRow(id);
				confirmPendingMove(id);
			} catch (err) {
				failedIds.push(id);
				throw err;
			}
		});
		setBulkBusy(false);
		if (failedIds.length > 0) {
			const failedSet = new Set(failedIds);
			for (const id of failedIds) {
				unhideRow(id);
				rollbackPendingMove(id);
				const parsed = parseMessageId(id);
				const info = meta.get(id);
				const target = idToTarget.get(id);
				if (parsed && info && target) applyMoveCountsDelta(target, parsed.folder, info.wasUnread);
				if (info) reviveMessageAt(info.original, info.originalIndex);
				const cached = cachedBodies.get(id);
				if (cached) messageCache.current.set(id, cached);
			}
			if (prevSelectedId && failedSet.has(prevSelectedId)) {
				setSelectedId(prevSelectedId);
				setSelectedMessage(prevSelected);
			}
			toast.error(`فشل استعادة ${failedIds.length} من ${ids.length} رسالة`);
		} else toast.success(`تم استعادة ${ids.length} رسالة`);
	}
	async function bulkMarkUnread() {
		if (!session || selection.size === 0 || bulkBusy) return;
		const ids = Array.from(selection);
		setBulkBusy(true);
		setMessages((prev) => prev.map((m) => selection.has(m.id) ? {
			...m,
			read: false
		} : m));
		ids.forEach((id) => {
			const c = messageCache.current.get(id);
			if (c) messageCache.current.set(id, {
				...c,
				read: false
			});
		});
		clearSelection();
		const { failed } = await runBatch(ids, 5, async (id) => {
			const parsed = parseMessageId(id);
			if (!parsed) return;
			await mutateFlag(parsed.folder, parsed.uid, "seen", false);
		});
		setBulkBusy(false);
		if (failed > 0) toast.error(`فشل تعليم ${failed} رسالة`);
		else toast.success(`تم تعليم ${ids.length} رسالة كغير مقروءة`);
		loadCountsSoft();
	}
	function loadCountsSoft() {
		setTimeout(() => loadCounts(), 300);
	}
	function handleSignOut() {
		clearAllPendingMoves();
		clearAccountOrigins(safeOriginStorage(), currentAccountId);
		clearMailSession();
		navigate({ to: "/login" });
	}
	if (session === void 0) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex h-screen items-center justify-center bg-background",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-6 w-6 animate-spin text-primary" })
	});
	if (!session) return null;
	const brandName = session.company?.app_name || session.company?.name || "MailMaestro";
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-screen w-full flex-col bg-background",
		children: [
			bridgeError && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-center gap-2 bg-warning px-3 py-2 text-xs font-medium text-warning-foreground",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(OctagonAlert, { className: "h-4 w-4" }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: bridgeError }),
					useMock && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "opacity-80",
						children: "(يتم عرض بيانات تجريبية مؤقتًا)"
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: () => setSidebarOpen((s) => !s),
						className: "rounded-lg p-2 hover:bg-muted lg:hidden",
						"aria-label": "القائمة",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Menu, { className: "h-5 w-5" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
						to: "/mail",
						className: "flex shrink-0 items-center gap-2",
						children: [session.company?.logo_url ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
							src: session.company.logo_url,
							alt: brandName,
							className: "h-8 w-8 rounded-lg object-cover"
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient text-white",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "h-4 w-4" })
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "hidden text-base font-bold sm:inline",
							children: brandName
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mx-2 flex flex-1 items-center gap-1 rounded-xl bg-muted/70 pe-1 ps-3 py-1.5 transition focus-within:bg-card focus-within:shadow-elevated sm:mx-4 sm:max-w-xl",
						children: [
							searchMode === "deep" ? deepLoading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 shrink-0 animate-spin text-primary" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Globe, { className: "h-4 w-4 shrink-0 text-primary" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Search, { className: "h-4 w-4 shrink-0 text-muted-foreground" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								value: query,
								onChange: (e) => setQuery(e.target.value),
								placeholder: searchMode === "deep" ? "بحث شامل على السيرفر…" : "ابحث في البريد...",
								className: "w-full bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
							}),
							query && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: () => setQuery(""),
								className: "rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
								title: "مسح",
								"aria-label": "مسح",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "h-3.5 w-3.5" })
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenu, {
								dir: "rtl",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuTrigger, {
									asChild: true,
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
										className: `flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition ${searchMode === "deep" ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground hover:bg-muted"}`,
										title: "خيارات البحث",
										children: [
											searchMode === "deep" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Globe, { className: "h-3.5 w-3.5" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Zap, { className: "h-3.5 w-3.5" }),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												className: "hidden sm:inline",
												children: searchMode === "deep" ? "شامل" : "سريع"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronDown, { className: "h-3 w-3 opacity-60" })
										]
									})
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuContent, {
									align: "end",
									className: "w-64",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground",
											children: "نمط البحث"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
											onSelect: () => setSearchMode("quick"),
											className: "flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Zap, { className: "mt-0.5 h-4 w-4 shrink-0 text-amber-500" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "flex-1",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
													className: "flex items-center justify-between",
													children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
														className: "font-medium",
														children: "بحث سريع"
													}), searchMode === "quick" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "h-3.5 w-3.5 text-primary" })]
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "text-[11px] text-muted-foreground",
													children: "فوري في الرسائل المعروضة — دون أي طلب للسيرفر"
												})]
											})]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
											onSelect: () => setSearchMode("deep"),
											className: "flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Globe, { className: "mt-0.5 h-4 w-4 shrink-0 text-primary" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "flex-1",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
													className: "flex items-center justify-between",
													children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
														className: "font-medium",
														children: "بحث شامل على السيرفر"
													}), searchMode === "deep" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "h-3.5 w-3.5 text-primary" })]
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "text-[11px] text-muted-foreground",
													children: "IMAP SEARCH على كامل المجلد الحالي (الموضوع + المرسل + المستلمين)"
												})]
											})]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
											onSelect: (e) => {
												e.preventDefault();
												if (searchMode !== "deep") setSearchMode("deep");
												setDeepIncludeBody((v) => !v);
											},
											className: "flex items-start gap-2 cursor-pointer hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
												className: "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border",
												children: deepIncludeBody && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "h-3 w-3 text-primary" })
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "flex-1",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "flex items-center justify-between",
													children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
														className: "font-medium",
														children: "تضمين نص الرسالة"
													})
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "text-[11px] text-muted-foreground",
													children: "أبطأ لكنه يبحث داخل محتوى الرسائل أيضاً"
												})]
											})]
										})
									]
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "ms-auto flex shrink-0 items-center gap-1.5",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "hidden max-w-[200px] truncate rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground md:inline-block",
								dir: "ltr",
								title: session.account.email_address,
								children: session.account.email_address
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								onClick: refresh,
								disabled: refreshing,
								className: "hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-70 sm:inline-flex",
								title: "تحديث البريد",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(RefreshCw, { className: `h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}` }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "hidden lg:inline",
									children: refreshing ? "جاري التحديث..." : "تحديث"
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: refresh,
								disabled: refreshing,
								className: "rounded-lg p-2 hover:bg-muted disabled:opacity-70 sm:hidden",
								"aria-label": "تحديث",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RefreshCw, { className: `h-4 w-4 ${refreshing ? "animate-spin text-primary" : ""}` })
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								onClick: handleSignOut,
								className: "hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:inline-flex",
								title: "تسجيل الخروج",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogOut, { className: "h-4 w-4" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "hidden lg:inline",
									children: "خروج"
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: handleSignOut,
								className: "rounded-lg p-2 hover:bg-muted sm:hidden",
								"aria-label": "خروج",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogOut, { className: "h-4 w-4" })
							})
						]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "relative flex flex-1 overflow-hidden",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
						className: `fixed inset-y-0 right-0 top-14 z-30 w-64 shrink-0 transform border-l border-border bg-sidebar transition-transform lg:relative lg:top-0 lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "translate-x-full lg:translate-x-0"}`,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "p-4",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								onClick: () => {
									setCompose({});
									setSidebarOpen(false);
								},
								className: "flex w-full items-center gap-3 rounded-2xl bg-brand-gradient px-5 py-3.5 text-sm font-semibold text-white shadow-brand transition hover:scale-[1.02]",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pencil, { className: "h-4 w-4" }), "رسالة جديدة"]
							})
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
							className: "px-2",
							children: Object.keys(FOLDER_META).filter((f) => counts[f]?.supported !== false).map((f) => {
								const meta = FOLDER_META[f];
								const active = f === folder;
								const Icon = meta.icon;
								const { total } = counts[f] || { total: 0 };
								return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									onClick: () => {
										setFolder(f);
										setSelectedId(null);
										setSelectedMessage(null);
										setSidebarOpen(false);
									},
									className: `mb-0.5 flex w-full items-center gap-3 rounded-r-full rounded-l-md px-4 py-2.5 text-sm transition ${active ? "bg-sidebar-hover font-semibold text-foreground" : "text-sidebar-foreground hover:bg-sidebar-hover/60"}`,
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { className: `h-4 w-4 ${active ? "text-primary" : ""}` }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "flex-1 text-right",
											children: meta.label
										}),
										total > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: `rounded-full px-1.5 text-[11px] font-bold ${active ? "text-primary" : "text-muted-foreground"}`,
											children: total
										})
									]
								}, f);
							})
						})]
					}),
					sidebarOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						onClick: () => setSidebarOpen(false),
						className: "fixed inset-0 top-14 z-20 bg-black/40 lg:hidden"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: `flex w-full flex-col border-l border-border bg-card md:w-96 md:shrink-0 ${selectedMessage || selectedId && reading ? "hidden md:flex" : "flex"}`,
						children: [selectMode || selection.size > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex h-11 shrink-0 items-center gap-2 border-b border-border bg-accent/40 px-4 text-xs",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									onClick: toggleSelectAllVisible,
									className: "flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted",
									title: selection.size >= filteredMessages.length && filteredMessages.length > 0 ? "إلغاء التحديد" : "تحديد الكل",
									children: selection.size >= filteredMessages.length && filteredMessages.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SquareCheckBig, { className: "h-5 w-5 text-primary" }) : selection.size > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SquareMinus, { className: "h-5 w-5 text-primary" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Square, { className: "h-5 w-5 text-muted-foreground" })
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "font-semibold text-foreground",
									children: selection.size > 0 ? `${selection.size} محددة` : "اختر الرسائل"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex-1" }),
								bulkBusy && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-3.5 w-3.5 animate-spin text-muted-foreground" }),
								selection.size > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenu, {
									dir: "rtl",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuTrigger, {
										asChild: true,
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
											disabled: bulkBusy,
											className: "flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50",
											title: "إجراءات",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(EllipsisVertical, { className: "h-4 w-4" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "إجراءات" })]
										})
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuContent, {
										align: "start",
										className: "w-56",
										children: [
											(folder === "trash" || folder === "archive") && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
												onClick: bulkRestore,
												disabled: bulkBusy,
												className: "cursor-pointer hover:bg-accent focus:bg-accent",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArchiveRestore, { className: "ms-2 h-4 w-4" }), "استعادة المحدد"]
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {})] }),
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
												onClick: () => bulkMove("archive"),
												disabled: bulkBusy,
												className: "cursor-pointer hover:bg-accent focus:bg-accent",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Archive, { className: "ms-2 h-4 w-4" }), "أرشفة المحدد"]
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
												onClick: () => bulkMove("spam"),
												disabled: bulkBusy,
												className: "cursor-pointer hover:bg-accent focus:bg-accent",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(OctagonAlert, { className: "ms-2 h-4 w-4" }), "نقل إلى المزعج"]
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
												onClick: bulkMarkUnread,
												disabled: bulkBusy,
												className: "cursor-pointer hover:bg-accent focus:bg-accent",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "ms-2 h-4 w-4" }), "تعليم كغير مقروءة"]
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
												onClick: bulkDelete,
												disabled: bulkBusy,
												className: "cursor-pointer text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:text-destructive",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Trash2, { className: "ms-2 h-4 w-4" }), folder === "trash" ? "حذف نهائياً" : "نقل إلى المهملات"]
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									onClick: toggleSelectMode,
									disabled: bulkBusy,
									className: "rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50",
									title: "إلغاء التحديد",
									children: "إلغاء"
								})
							]
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex h-11 shrink-0 items-center justify-between border-b border-border px-4 text-xs",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center gap-3",
								children: [selectMode && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									onClick: toggleSelectAllVisible,
									disabled: filteredMessages.length === 0,
									className: "flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40",
									title: "تحديد الكل",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Square, { className: "h-5 w-5 text-muted-foreground" })
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "font-semibold text-muted-foreground",
									children: inDeepSearch ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "flex items-center gap-1.5",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Globe, { className: "h-3.5 w-3.5 text-primary" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
											"نتائج السيرفر · ",
											filteredMessages.length,
											deepIncludeBody && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												className: "ms-1 text-[10px] text-primary/70",
												children: "(يشمل المحتوى)"
											})
										] })]
									}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: ["المعروضة · ", filteredMessages.length] })
								})]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center gap-1",
								children: [
									loading && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-3.5 w-3.5 animate-spin text-muted-foreground" }),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										onClick: toggleSelectMode,
										className: `rounded px-2 py-1.5 text-xs font-medium transition ${selectMode ? "bg-primary text-primary-foreground hover:bg-primary/90" : "text-foreground hover:bg-muted"}`,
										children: selectMode ? "إلغاء" : "تحديد"
									}),
									!inDeepSearch && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenu, {
										dir: "rtl",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuTrigger, {
											asChild: true,
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
												className: "flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-foreground hover:bg-muted",
												title: "ترتيب العرض",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowUpDown, { className: "h-3.5 w-3.5" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "ترتيب" })]
											})
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuContent, {
											align: "start",
											className: "w-56",
											children: [
												{
													value: "date-desc",
													label: "الأحدث أولاً"
												},
												{
													value: "date-asc",
													label: "الأقدم أولاً"
												},
												{
													value: "unread-first",
													label: "غير المقروءة أولاً"
												},
												{
													value: "starred-first",
													label: "المميّزة بنجمة أولاً"
												}
											].map((opt, i) => {
												const disabled = folder === "starred" && opt.value === "starred-first";
												return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [i > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
													disabled,
													onClick: () => !disabled && setSort(opt.value),
													className: "flex items-center justify-between gap-2 hover:bg-accent focus:bg-accent",
													children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: opt.label }), sort === opt.value && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "h-4 w-4 text-primary" })]
												})] }, opt.value);
											})
										})]
									})
								]
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "flex-1 overflow-hidden",
							children: (loading || inDeepSearch && deepLoading) && filteredMessages.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex h-full flex-col items-center justify-center gap-3 text-center",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-6 w-6 animate-spin text-primary" }), inDeepSearch && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "text-xs text-muted-foreground",
									children: "جاري البحث على السيرفر…"
								})]
							}) : filteredMessages.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "h-10 w-10 opacity-30" }), inDeepSearch ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "text-sm",
									children: deepError ? deepError : "لا توجد نتائج على السيرفر"
								}), !deepError && !deepIncludeBody && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "text-[11px] text-muted-foreground/70",
									children: "جرّب تفعيل «تضمين نص الرسالة» من خيارات البحث"
								})] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "text-sm",
									children: "لا توجد رسائل هنا"
								})]
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(es, {
								style: { height: "100%" },
								data: filteredMessages,
								overscan: 800,
								increaseViewportBy: {
									top: 400,
									bottom: 800
								},
								computeItemKey: (_, m) => m.id,
								endReached: () => {
									if (!query.trim() && !inDeepSearch) loadMore();
								},
								itemContent: (_, m) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MessageRow, {
									message: m,
									active: m.id === selectedId,
									selected: selection.has(m.id),
									anySelected: selection.size > 0,
									selectMode,
									onClick: () => {
										if (selectMode) toggleSelect(m.id);
										else openMessage(m.id);
									},
									onPrefetch: () => prefetchMessage(m.id),
									onToggleStar: (e) => toggleStar(e, m.id),
									onToggleRead: (e) => toggleRead(e, m.id),
									onToggleSelect: () => toggleSelect(m.id)
								}),
								components: { Footer: () => loadingMore ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }), " جاري تحميل المزيد…"]
								}) : !hasMore && filteredMessages.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "py-4 text-center text-[11px] text-muted-foreground",
									children: "— نهاية الرسائل —"
								}) : null }
							})
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: `flex-1 overflow-hidden bg-surface ${selectedMessage || selectedId && reading ? "flex" : "hidden md:flex"} flex-col`,
						children: selectedMessage ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MessageView, {
							message: selectedMessage,
							loading: reading,
							myEmail: session.account.email_address,
							onBack: () => {
								setSelectedId(null);
								setSelectedMessage(null);
							},
							onReply: () => setCompose(buildReply(selectedMessage, session.account.email_address, false)),
							onReplyAll: () => setCompose(buildReply(selectedMessage, session.account.email_address, true)),
							onForward: () => setCompose(buildForward(selectedMessage)),
							onArchive: () => handleMove(selectedMessage.id, "archive"),
							onDelete: () => handleDelete(selectedMessage.id),
							onSpam: () => handleMove(selectedMessage.id, "spam"),
							onMarkUnread: () => handleMarkUnread(selectedMessage.id),
							onRestore: () => handleRestore(selectedMessage.id),
							onPrint: () => {}
						}) : selectedId && reading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoadingViewer, { onBack: () => {
							setSelectedId(null);
							setSelectedMessage(null);
						} }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyViewer, {})
					})
				]
			}),
			compose && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Composer, {
				session,
				initial: compose,
				onClose: () => setCompose(null),
				onSent: onAfterSend
			})
		]
	});
}
function MessageRow({ message, active, selected, anySelected, selectMode, onClick, onPrefetch, onToggleStar, onToggleRead, onToggleSelect }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		role: "button",
		tabIndex: 0,
		onClick,
		onKeyDown: (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onClick();
			}
		},
		onMouseEnter: onPrefetch,
		onFocus: onPrefetch,
		onTouchStart: onPrefetch,
		className: `group flex w-full cursor-pointer items-start gap-3 border-b border-border/60 px-4 py-3 text-right transition-colors duration-150 hover:bg-muted/50 active:bg-muted active:duration-75 ${active ? "bg-accent" : ""} ${selected ? "bg-primary/5" : ""} ${!message.read ? "bg-card" : "bg-card/70"}`,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "relative flex h-9 w-9 shrink-0 items-center justify-center",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: `flex h-9 w-9 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white transition ${selectMode || selected ? "opacity-0" : "opacity-100"}`,
				children: message.from.name.charAt(0) || message.from.email.charAt(0)
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				role: "checkbox",
				"aria-checked": selected,
				tabIndex: 0,
				onClick: (e) => {
					e.stopPropagation();
					onToggleSelect();
				},
				onKeyDown: (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						e.stopPropagation();
						onToggleSelect();
					}
				},
				className: `absolute inset-0 z-10 flex items-center justify-center rounded-full transition ${selectMode || selected ? "opacity-100" : "opacity-0"}`,
				title: selected ? "إلغاء التحديد" : "تحديد",
				children: selected ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SquareCheckBig, { className: "h-5 w-5 text-primary" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Square, { className: "h-5 w-5 text-muted-foreground" })
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex-1 overflow-hidden",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mb-0.5 flex items-baseline justify-between gap-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: `truncate text-sm ${!message.read ? "font-bold text-foreground" : "font-medium text-foreground/80"}`,
						children: message.from.name || message.from.email
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "shrink-0 text-[11px] text-muted-foreground",
						children: formatDate(message.date)
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: `truncate text-sm ${!message.read ? "font-semibold text-foreground" : "text-muted-foreground"}`,
					children: message.subject
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-0.5 truncate text-xs text-muted-foreground",
					children: message.preview
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-1 flex items-center gap-2",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: (e) => {
								e.stopPropagation();
								onToggleStar(e);
							},
							className: `rounded p-0.5 hover:bg-muted ${message.starred ? "text-star" : "text-muted-foreground"}`,
							title: message.starred ? "إزالة المميّز" : "تمييز",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Star, { className: `h-3.5 w-3.5 ${message.starred ? "fill-star" : ""}` })
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: (e) => {
								e.stopPropagation();
								onToggleRead(e);
							},
							className: "rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground",
							title: message.read ? "تعليم كغير مقروءة" : "تعليم كمقروءة",
							children: message.read ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "h-3.5 w-3.5" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MailOpen, { className: "h-3.5 w-3.5" })
						}),
						message.hasAttachments && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Paperclip, { className: "h-3 w-3 text-muted-foreground" }),
						message.labels?.map((l) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground",
							children: l
						}, l))
					]
				})
			]
		})]
	});
}
function MessageView({ message, loading, myEmail, onBack, onReply, onReplyAll, onForward, onArchive, onDelete, onSpam, onMarkUnread, onRestore, onPrint }) {
	const [detailsOpen, setDetailsOpen] = (0, import_react.useState)(false);
	const recipientsAll = [...message.to.map((t) => ({
		...t,
		kind: "to"
	})), ...(message.cc || []).map((c) => ({
		...c,
		kind: "cc"
	}))];
	const toSummary = recipientsAll.length > 0 ? recipientsAll.map((r) => r.email).join("، ") : "—";
	const fullDate = new Date(message.date).toLocaleString("ar", {
		dateStyle: "full",
		timeStyle: "short"
	});
	const isTrash = message.folder === "trash";
	const canRestore = message.folder === "trash" || message.folder === "archive";
	const isSecure = !!message.security && !/غير/.test(message.security);
	async function copyEmail() {
		try {
			await navigator.clipboard.writeText(message.from.email);
			toast.success("تم نسخ البريد");
		} catch {
			toast.error("تعذّر النسخ");
		}
	}
	function printMessage() {
		const win = window.open("", "_blank", "width=800,height=900");
		if (!win) {
			toast.error("تعذّر فتح نافذة الطباعة");
			return;
		}
		const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"\"": "&quot;",
			"'": "&#39;"
		})[c]);
		const subject = esc(message.subject || "(بدون موضوع)");
		const fromName = esc(message.from.name || message.from.email);
		const fromEmail = esc(message.from.email);
		const to = esc(message.to.map((t) => t.email).join(", "));
		const cc = message.cc && message.cc.length > 0 ? esc(message.cc.map((c) => c.email).join(", ")) : "";
		const date = esc(new Date(message.date).toLocaleString("ar"));
		const body = message.body ? sanitizeEmailHtml(message.body) : esc(message.preview);
		win.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${subject}</title>
<style>
  body{font-family:'IBM Plex Sans Arabic',system-ui,sans-serif;color:#111;padding:24px;line-height:1.6}
  h1{font-size:20px;margin:0 0 16px}
  .meta{font-size:12px;color:#555;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:16px}
  .meta div{margin:2px 0}
  .body{font-size:14px}
  img{max-width:100%;height:auto}
  a{color:#0645ad;word-break:break-all}
</style></head><body>
<h1>${subject}</h1>
<div class="meta">
  <div><strong>المرسل:</strong> ${fromName} &lt;${fromEmail}&gt;</div>
  <div><strong>المستلم:</strong> <span dir="ltr">${to}</span></div>
  ${cc ? `<div><strong>نسخة:</strong> <span dir="ltr">${cc}</span></div>` : ""}
  <div><strong>التاريخ:</strong> ${date}</div>
</div>
<div class="body">${body}</div>
<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
</body></html>`);
		win.document.close();
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
				onClick: onBack,
				className: "flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden",
				"aria-label": "رجوع",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronLeft, { className: "h-4 w-4" }), " رجوع"]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "hidden gap-1 md:flex",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onReply,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "رد",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Reply, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onReplyAll,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "رد على الكل",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ReplyAll, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onForward,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "إعادة توجيه",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Forward, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "mx-1 h-6 w-px bg-border" }),
					canRestore && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onRestore,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "استعادة إلى المجلد الأصلي",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArchiveRestore, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onArchive,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "أرشفة",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Archive, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onSpam,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "مزعج",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(OctagonAlert, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onMarkUnread,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "تعليم كغير مقروءة",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MailOpen, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: printMessage,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "طباعة",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Printer, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: copyEmail,
						className: "rounded-lg p-2 hover:bg-muted",
						title: "نسخ عنوان المرسل",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Copy, { className: "h-4 w-4" })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "mx-1 h-6 w-px bg-border" }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onDelete,
						className: "rounded-lg p-2 text-destructive hover:bg-destructive/10",
						title: isTrash ? "حذف نهائي" : "نقل إلى المهملات",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Trash2, { className: "h-4 w-4" })
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenu, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuTrigger, {
				asChild: true,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					className: "rounded-lg p-2 hover:bg-muted",
					"aria-label": "خيارات أكثر",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EllipsisVertical, { className: "h-4 w-4" })
				})
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuContent, {
				align: "end",
				sideOffset: 8,
				collisionPadding: 12,
				className: "w-56 [direction:rtl] [&_[role=menuitem]]:flex-row [&_[role=menuitem]]:justify-start [&_[role=menuitem]]:text-right",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onReply,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Reply, { className: "h-4 w-4" }), " رد"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onReplyAll,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ReplyAll, { className: "h-4 w-4" }), " رد على الكل"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onForward,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Forward, { className: "h-4 w-4" }), " إعادة توجيه"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onMarkUnread,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MailOpen, { className: "h-4 w-4" }), " تعليم كغير مقروءة"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: printMessage,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Printer, { className: "h-4 w-4" }), " طباعة"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: copyEmail,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Copy, { className: "h-4 w-4" }), " نسخ عنوان المرسل"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DropdownMenuSeparator, {}),
					canRestore && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onRestore,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArchiveRestore, { className: "h-4 w-4" }), " استعادة إلى المجلد الأصلي"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onArchive,
						className: "md:hidden",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Archive, { className: "h-4 w-4" }), " أرشفة"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onSpam,
						className: "md:hidden",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(OctagonAlert, { className: "h-4 w-4" }), " مزعج"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(DropdownMenuItem, {
						onClick: onDelete,
						className: "text-destructive focus:text-destructive",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Trash2, { className: "h-4 w-4" }),
							" ",
							isTrash ? "حذف نهائي" : "نقل إلى المهملات"
						]
					})
				]
			})] })
		]
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex-1 overflow-y-auto",
		children: loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "flex h-full items-center justify-center",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-6 w-6 animate-spin text-primary" })
		}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto max-w-3xl p-4 sm:p-6",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
					className: "break-words text-xl font-bold leading-snug sm:text-2xl",
					children: message.subject || "(بدون موضوع)"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-4 flex items-start gap-3 border-b border-border pb-4",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-sm font-bold text-white",
						children: (message.from.name || message.from.email || "?").charAt(0).toUpperCase()
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0 flex-1",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-start justify-between gap-2",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 flex-1",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "truncate font-semibold leading-tight",
									children: message.from.name || message.from.email || "(مرسل غير معروف)"
								}), message.from.name && message.from.email && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "truncate text-xs text-muted-foreground",
									title: message.from.email,
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										dir: "ltr",
										style: { unicodeBidi: "isolate" },
										children: message.from.email
									})
								})]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "shrink-0 whitespace-nowrap text-xs text-muted-foreground",
								title: new Date(message.date).toLocaleString("ar"),
								children: formatDate(message.date)
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "mt-1 text-xs text-muted-foreground",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => setDetailsOpen((v) => !v),
								"aria-expanded": detailsOpen,
								className: "inline-flex max-w-full items-center gap-1 rounded hover:text-foreground",
								title: "تفاصيل الرسالة",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									className: "truncate",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "text-foreground/70",
										children: "إلى "
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										dir: "ltr",
										className: "unicode-bidi-isolate",
										children: toSummary
									})]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronDown, { className: `h-3.5 w-3.5 shrink-0 transition-transform ${detailsOpen ? "rotate-180" : ""}` })]
							}), detailsOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "mt-2 rounded-lg border border-border bg-muted/40 p-3",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
									className: "grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1.5 text-xs",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
											className: "text-foreground/70 whitespace-nowrap",
											children: "المرسل:"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dd", {
											className: "min-w-0 break-all",
											children: [message.from.name ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												className: "ml-1",
												children: message.from.name
											}) : null, /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
												dir: "ltr",
												className: "text-muted-foreground",
												children: [
													"<",
													message.from.email || "—",
													">"
												]
											})]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
											className: "text-foreground/70 whitespace-nowrap",
											children: "المستلم:"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
											className: "min-w-0 break-all",
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												dir: "ltr",
												style: { unicodeBidi: "isolate" },
												children: message.to.length > 0 ? message.to.map((t) => t.email).join(", ") : "—"
											})
										}),
										message.cc && message.cc.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
											className: "text-foreground/70 whitespace-nowrap",
											children: "نسخة:"
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
											className: "min-w-0 break-all",
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												dir: "ltr",
												style: { unicodeBidi: "isolate" },
												children: message.cc.map((c) => c.email).join(", ")
											})
										})] }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
											className: "text-foreground/70 whitespace-nowrap",
											children: "التاريخ:"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
											className: "min-w-0",
											children: fullDate
										}),
										message.mailedBy && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
											className: "text-foreground/70 whitespace-nowrap",
											children: "الخادم:"
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
											className: "min-w-0 break-all",
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												dir: "ltr",
												style: { unicodeBidi: "isolate" },
												children: message.mailedBy
											})
										})] }),
										message.signedBy && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
											className: "text-foreground/70 whitespace-nowrap",
											children: "التوقيع:"
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
											className: "min-w-0 break-all",
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												dir: "ltr",
												style: { unicodeBidi: "isolate" },
												children: message.signedBy
											})
										})] }),
										message.security && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
											className: "text-foreground/70 whitespace-nowrap",
											children: "الأمان:"
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dd", {
											className: "min-w-0 inline-flex items-center gap-1",
											children: [isSecure ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShieldCheck, { className: "h-3.5 w-3.5 text-emerald-600" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShieldAlert, { className: "h-3.5 w-3.5 text-amber-600" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: message.security })]
										})] })
									]
								})
							})]
						})]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("article", {
					className: "prose prose-sm mt-6 max-w-none break-words text-foreground prose-a:text-brand-accent prose-img:rounded-lg",
					dangerouslySetInnerHTML: { __html: sanitizeEmailHtml(message.body || message.preview || "") }
				}),
				message.attachments && message.attachments.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-6",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "mb-2 text-xs font-semibold text-muted-foreground",
						children: [
							"المرفقات (",
							message.attachments.length,
							")"
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "grid gap-2 sm:grid-cols-2",
						children: message.attachments.map((a) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AttachmentCard, {
							attachment: a,
							message
						}, a.id))
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-6 flex flex-wrap gap-2",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							onClick: onReply,
							className: "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Reply, { className: "h-4 w-4" }), " رد"]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							onClick: onReplyAll,
							className: "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ReplyAll, { className: "h-4 w-4" }), " رد على الكل"]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							onClick: onForward,
							className: "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Forward, { className: "h-4 w-4" }), " إعادة توجيه"]
						})
					]
				})
			]
		})
	})] });
}
function EmptyViewer() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Mail, { className: "h-16 w-16 opacity-30" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "text-sm",
			children: "اختر رسالة من القائمة لعرضها"
		})]
	});
}
function LoadingViewer({ onBack }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
			onClick: onBack,
			className: "flex items-center gap-1.5 rounded-lg p-2 text-sm hover:bg-muted md:hidden",
			"aria-label": "رجوع",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronLeft, { className: "h-4 w-4" }), " رجوع"]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {})]
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex flex-1 items-center justify-center",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-6 w-6 animate-spin text-primary" })
	})] });
}
var COMPOSE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
var COMPOSE_MAX_FILES = 10;
function formatBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function Composer({ session, initial, onClose, onSent }) {
	const [to, setTo] = (0, import_react.useState)(initial?.to ?? "");
	const [cc, setCc] = (0, import_react.useState)(initial?.cc ?? "");
	const [subject, setSubject] = (0, import_react.useState)(initial?.subject ?? "");
	const [body, setBody] = (0, import_react.useState)(initial?.body ?? "");
	const [files, setFiles] = (0, import_react.useState)([]);
	const [sending, setSending] = (0, import_react.useState)(false);
	const [progress, setProgress] = (0, import_react.useState)(0);
	const fileInputRef = (0, import_react.useRef)(null);
	const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
	function handlePickFiles(list) {
		if (!list || list.length === 0) return;
		const incoming = Array.from(list);
		const merged = [...files];
		let runningTotal = totalBytes;
		for (const f of incoming) {
			if (merged.length >= COMPOSE_MAX_FILES) {
				toast.error(`الحد الأقصى ${COMPOSE_MAX_FILES} ملفات`);
				break;
			}
			if (runningTotal + f.size > COMPOSE_MAX_TOTAL_BYTES) {
				toast.error(`تجاوزت الحد الكلّي (25MB)`);
				break;
			}
			merged.push(f);
			runningTotal += f.size;
		}
		setFiles(merged);
		if (fileInputRef.current) fileInputRef.current.value = "";
	}
	function removeFile(index) {
		setFiles((prev) => prev.filter((_, i) => i !== index));
	}
	async function handleSend() {
		if (!to || !subject) return;
		setSending(true);
		setProgress(0);
		try {
			const parseAddresses = (raw) => raw.split(",").map((s) => s.trim()).filter(Boolean).map((email) => ({
				name: "",
				email
			}));
			const payload = {
				mailSessionToken: session.mailSessionToken ?? "",
				password: session.password,
				to: parseAddresses(to),
				cc: parseAddresses(cc),
				bcc: [],
				subject,
				bodyHtml: body,
				bodyText: body
			};
			const form = new FormData();
			form.append("payload", JSON.stringify(payload));
			for (const f of files) form.append("attachments", f, f.name);
			const result = await new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.open("POST", "/api/mail-send");
				xhr.upload.onprogress = (e) => {
					if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100));
				};
				xhr.onload = () => {
					try {
						const json = JSON.parse(xhr.responseText || "{}");
						if (xhr.status >= 200 && xhr.status < 300 && json.ok) resolve({ ok: true });
						else resolve({
							ok: false,
							error: json.error || `HTTP ${xhr.status}`
						});
					} catch {
						resolve({
							ok: false,
							error: `HTTP ${xhr.status}`
						});
					}
				};
				xhr.onerror = () => reject(/* @__PURE__ */ new Error("Network error"));
				xhr.send(form);
			});
			if (!result.ok) {
				toast.error(result.error || "فشل إرسال الرسالة");
				return;
			}
			toast.success("تم إرسال الرسالة");
			onClose();
			onSent();
		} catch (err) {
			toast.error(err?.message || "فشل إرسال الرسالة");
		} finally {
			setSending(false);
			setProgress(0);
		}
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "fixed inset-x-0 bottom-0 z-40 mx-auto max-w-2xl rounded-t-2xl border border-border bg-card shadow-float sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[560px]",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between border-b border-border px-4 py-2.5",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm font-semibold",
					children: "رسالة جديدة"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					onClick: onClose,
					className: "rounded-md p-1 hover:bg-muted",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "h-4 w-4" })
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "p-4",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						value: to,
						onChange: (e) => setTo(e.target.value),
						placeholder: "إلى",
						dir: "ltr",
						className: "w-full border-b border-border bg-transparent px-1 py-2 text-sm outline-none"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						value: cc,
						onChange: (e) => setCc(e.target.value),
						placeholder: "Cc",
						dir: "ltr",
						className: "w-full border-b border-border bg-transparent px-1 py-2 text-sm outline-none"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						value: subject,
						onChange: (e) => setSubject(e.target.value),
						placeholder: "الموضوع",
						className: "w-full border-b border-border bg-transparent px-1 py-2 text-sm outline-none"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
						value: body,
						onChange: (e) => setBody(e.target.value),
						rows: 8,
						placeholder: "اكتب رسالتك هنا...",
						className: "w-full resize-none bg-transparent px-1 py-2 text-sm outline-none"
					}),
					files.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-2 flex flex-wrap gap-2 border-t border-border pt-3",
						children: [files.map((f, i) => {
							const { Icon, tint } = getAttachmentIcon(f.type, f.name);
							return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "group inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: `inline-flex h-6 w-6 items-center justify-center rounded-md ${tint}`,
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { className: "h-3.5 w-3.5" })
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										className: "flex flex-col leading-tight",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "max-w-[160px] truncate font-medium",
											children: f.name
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "text-[10px] text-muted-foreground",
											children: formatBytes(f.size)
										})]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										onClick: () => removeFile(i),
										disabled: sending,
										className: "rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100",
										"aria-label": "حذف المرفق",
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "h-3.5 w-3.5" })
									})
								]
							}, `${f.name}-${i}`);
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "self-center text-[11px] text-muted-foreground",
							children: [formatBytes(totalBytes), " / 25 MB"]
						})]
					}),
					sending && progress > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-3 h-1 overflow-hidden rounded-full bg-muted",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "h-full bg-brand-gradient transition-all",
							style: { width: `${progress}%` }
						})
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between border-t border-border px-4 py-2.5",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						onClick: handleSend,
						disabled: sending || !to || !subject,
						className: "inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-60",
						children: [sending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Send, { className: "h-4 w-4" }), sending ? progress > 0 ? `جاري الإرسال ${progress}%` : "جاري الإرسال" : "إرسال"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						ref: fileInputRef,
						type: "file",
						multiple: true,
						className: "hidden",
						onChange: (e) => handlePickFiles(e.target.files)
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => fileInputRef.current?.click(),
						disabled: sending || files.length >= COMPOSE_MAX_FILES,
						className: "rounded-md p-2 hover:bg-muted disabled:opacity-40",
						"aria-label": "إرفاق ملف",
						title: "إرفاق ملف",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Paperclip, { className: "h-4 w-4" })
					})
				]
			})
		]
	});
}
var INLINE_PREVIEW_MIME = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"application/pdf"
]);
function getAttachmentIcon(mimeType, filename) {
	const mime = (mimeType || "").toLowerCase();
	const ext = (filename.split(".").pop() || "").toLowerCase();
	if (mime.startsWith("image/")) return {
		Icon: FileImage,
		tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
	};
	if (mime.startsWith("video/")) return {
		Icon: FilePlay,
		tint: "bg-purple-500/10 text-purple-600 dark:text-purple-400"
	};
	if (mime.startsWith("audio/")) return {
		Icon: FileHeadphone,
		tint: "bg-pink-500/10 text-pink-600 dark:text-pink-400"
	};
	if (mime === "application/pdf" || ext === "pdf") return {
		Icon: FileType,
		tint: "bg-red-500/10 text-red-600 dark:text-red-400"
	};
	if (/zip|rar|7z|tar|gzip|compressed/.test(mime) || [
		"zip",
		"rar",
		"7z",
		"tar",
		"gz"
	].includes(ext)) return {
		Icon: FileArchive,
		tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400"
	};
	if (/sheet|excel|csv/.test(mime) || [
		"xls",
		"xlsx",
		"csv",
		"ods"
	].includes(ext)) return {
		Icon: FileSpreadsheet,
		tint: "bg-green-500/10 text-green-600 dark:text-green-400"
	};
	if (/word|document|opendocument\.text/.test(mime) || [
		"doc",
		"docx",
		"odt",
		"rtf"
	].includes(ext)) return {
		Icon: FileText,
		tint: "bg-blue-500/10 text-blue-600 dark:text-blue-400"
	};
	if (/presentation|powerpoint/.test(mime) || [
		"ppt",
		"pptx",
		"odp",
		"key"
	].includes(ext)) return {
		Icon: FileType,
		tint: "bg-orange-500/10 text-orange-600 dark:text-orange-400"
	};
	if (/json|xml|javascript|typescript|html|css|x-sh|x-python/.test(mime) || [
		"js",
		"ts",
		"tsx",
		"jsx",
		"json",
		"xml",
		"html",
		"css",
		"py",
		"sh",
		"java",
		"c",
		"cpp",
		"go",
		"rs"
	].includes(ext)) return {
		Icon: FileCode,
		tint: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
	};
	if (mime.startsWith("text/") || [
		"txt",
		"md",
		"log"
	].includes(ext)) return {
		Icon: FileText,
		tint: "bg-slate-500/10 text-slate-600 dark:text-slate-400"
	};
	return {
		Icon: Paperclip,
		tint: "bg-brand-gradient/10 text-brand-accent"
	};
}
function AttachmentCard({ attachment, message }) {
	const [busy, setBusy] = (0, import_react.useState)(null);
	const [previewUrl, setPreviewUrl] = (0, import_react.useState)(null);
	const canPreview = INLINE_PREVIEW_MIME.has((attachment.mimeType || "").toLowerCase());
	const canDownload = !!attachment.part;
	(0, import_react.useEffect)(() => {
		return () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		};
	}, [previewUrl]);
	async function fetchBlob() {
		const session = getMailSession();
		if (!session) {
			toast.error("انتهت الجلسة");
			return null;
		}
		const parsed = parseMessageId(message.id);
		if (!parsed || !attachment.part) {
			toast.error("لا يمكن تحديد المرفق");
			return null;
		}
		const res = await fetch("/api/mail-attachment", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mailSessionToken: session.mailSessionToken ?? "",
				password: session.password,
				folder: parsed.folder,
				uid: parsed.uid,
				part: attachment.part
			})
		});
		if (!res.ok) {
			const msg = await res.text().catch(() => "");
			toast.error(`تعذّر تنزيل المرفق${msg ? `: ${msg.slice(0, 100)}` : ""}`);
			return null;
		}
		return await res.blob();
	}
	async function handleDownload() {
		if (busy || !canDownload) return;
		setBusy("download");
		try {
			const blob = await fetchBlob();
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = attachment.filename || "attachment";
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1500);
		} finally {
			setBusy(null);
		}
	}
	async function handlePreview() {
		if (busy || !canDownload || !canPreview) return;
		setBusy("preview");
		try {
			const blob = await fetchBlob();
			if (!blob) return;
			if (previewUrl) URL.revokeObjectURL(previewUrl);
			setPreviewUrl(URL.createObjectURL(blob));
		} finally {
			setBusy(null);
		}
	}
	const { Icon: FileIcon, tint } = getAttachmentIcon(attachment.mimeType, attachment.filename);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-2.5 rounded-xl border border-border bg-card p-2.5 sm:gap-3 sm:p-3",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 ${tint}`,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FileIcon, { className: "h-4 w-4 sm:h-5 sm:w-5" })
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "line-clamp-2 break-all text-[13px] font-medium leading-snug sm:text-sm",
					title: attachment.filename,
					children: attachment.filename
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-0.5 text-[11px] text-muted-foreground sm:text-xs",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("bdi", {
						dir: "ltr",
						children: formatSize(attachment.size)
					})
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex shrink-0 items-center gap-1",
				children: [canPreview && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: handlePreview,
					disabled: !canDownload || busy !== null,
					title: "معاينة",
					"aria-label": "معاينة",
					className: "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8",
					children: busy === "preview" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "h-4 w-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Eye, { className: "h-4 w-4" })
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: handleDownload,
					disabled: !canDownload || busy !== null,
					title: canDownload ? "تنزيل" : "غير متاح",
					"aria-label": "تنزيل",
					className: "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8",
					children: busy === "download" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleArrowDown, { className: "h-4 w-4 animate-bounce text-primary" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Download, { className: "h-4 w-4" })
				})]
			})
		]
	}), previewUrl && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm",
		onClick: () => setPreviewUrl(null),
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-white",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "truncate text-sm font-medium",
				children: attachment.filename
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: (e) => {
						e.stopPropagation();
						handleDownload();
					},
					className: "inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Download, { className: "h-3.5 w-3.5" }), " تنزيل"]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => setPreviewUrl(null),
					className: "inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/10 hover:bg-white/20",
					title: "إغلاق",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "h-4 w-4" })
				})]
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "flex flex-1 items-center justify-center overflow-auto p-4",
			onClick: (e) => e.stopPropagation(),
			children: attachment.mimeType.startsWith("image/") ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
				src: previewUrl,
				alt: attachment.filename,
				className: "max-h-full max-w-full rounded-lg object-contain shadow-2xl"
			}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("iframe", {
				src: previewUrl,
				title: attachment.filename,
				className: "h-full w-full rounded-lg bg-white shadow-2xl"
			})
		})]
	})] });
}
//#endregion
export { MailApp as component };
