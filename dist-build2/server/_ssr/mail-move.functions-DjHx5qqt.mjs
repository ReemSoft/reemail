import { l as createServerFn } from "./esm-Dova13aH.mjs";
import { t as createServerRpc } from "./createServerRpc-WJgk8O8C.mjs";
import { a as numberType, o as objectType, r as enumType, s as stringType } from "../_libs/zod.mjs";
import processModule from "node:process";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-move.functions-DjHx5qqt.js
async function moveMessageOrchestration(deps, input) {
	const logErr = deps.logError ?? (() => {});
	let source = null;
	let destBefore = {
		folder: null,
		cursorNewestSyncedUid: null
	};
	try {
		source = await deps.loadSource();
	} catch (e) {
		logErr("[move] loadSource failed", e);
	}
	try {
		destBefore = await deps.loadDest();
	} catch (e) {
		logErr("[move] loadDest failed", e);
	}
	const bridge = await deps.bridgeMove();
	if (!bridge.ok) return {
		ok: false,
		error: bridge.error,
		code: bridge.code
	};
	const move = bridge.move;
	let indexApplied = "partial";
	let destinationInserted = false;
	let writeThroughFailed = false;
	try {
		const wt = await deps.applyWriteThrough(move);
		if (wt.ok) {
			indexApplied = wt.applied;
			destinationInserted = wt.destinationInserted;
		} else {
			writeThroughFailed = true;
			logErr("[move] applyWriteThrough failed", wt.error);
		}
	} catch (e) {
		writeThroughFailed = true;
		logErr("[move] applyWriteThrough threw", e);
	}
	const fullMapping = move.uidMappingAvailable && indexApplied === "full" && destinationInserted && typeof move.destinationUid === "number" && typeof move.destinationUidValidity === "string";
	let destinationSync = "not-needed";
	let destinationReady = false;
	let discoveredUid;
	let discoveredUv;
	if (fullMapping) {
		destinationReady = true;
		discoveredUid = move.destinationUid;
		discoveredUv = move.destinationUidValidity;
	} else {
		const destPath = move.destinationPath ?? destBefore.folder?.path ?? null;
		const cutoff = destBefore.cursorNewestSyncedUid ?? 0;
		if (!destPath) destinationSync = "failed";
		else {
			const mode = destBefore.folder && destBefore.cursorNewestSyncedUid != null ? "incremental" : "initial";
			destinationSync = mode;
			let rounds = 0;
			let currentDest = destBefore;
			while (rounds < 3) {
				rounds += 1;
				const syncRes = await deps.runDestSync({
					folderPath: destPath,
					canonical: input.destCanonical,
					mode
				});
				if (syncRes.ok && syncRes.busy) {
					destinationSync = "busy";
					break;
				}
				if (!syncRes.ok) {
					destinationSync = "failed";
					break;
				}
				try {
					currentDest = await deps.reloadDest();
				} catch (e) {
					logErr("[move] reloadDest failed", e);
				}
				if (source?.fingerprint && currentDest.folder && currentDest.folder.uidvalidity != null) try {
					const hit = await deps.discoverDest({
						folderId: currentDest.folder.id,
						uidvalidity: currentDest.folder.uidvalidity,
						cutoffUid: cutoff,
						fingerprint: source.fingerprint
					});
					if (hit) {
						destinationReady = true;
						discoveredUid = hit.uid;
						discoveredUv = String(hit.uidvalidity);
						break;
					}
				} catch (e) {
					logErr("[move] discoverDest failed", e);
				}
				if (mode !== "incremental" || !syncRes.hasMore) break;
			}
		}
	}
	let sourceConfirmation = "tombstone-only";
	if (source && source.cursorNewestSyncedUid != null) try {
		const res = await deps.runSourceReconcile({
			folderPath: source.path,
			canonical: source.canonical,
			uid: input.sourceUid
		});
		if (res.ok && !res.busy) sourceConfirmation = res.targetUidPresent ? "still-present" : "confirmed-absent";
		else if (res.ok && res.busy) sourceConfirmation = "busy";
		else sourceConfirmation = "failed";
	} catch (e) {
		logErr("[move] runSourceReconcile failed", e);
		sourceConfirmation = "failed";
	}
	const out = {
		ok: true,
		imap: true,
		move,
		index: writeThroughFailed || destinationSync === "failed" || destinationSync === "busy" || sourceConfirmation === "failed" || sourceConfirmation === "busy" || sourceConfirmation === "still-present" ? "partial" : indexApplied,
		sourceConfirmation,
		destinationSync,
		destinationReady
	};
	if (destinationReady && discoveredUid != null) {
		out.discoveredDestinationUid = discoveredUid;
		if (discoveredUv != null) out.discoveredDestinationUidValidity = discoveredUv;
	}
	return out;
}
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
	sourceCanonical: CanonicalSchema,
	destCanonical: CanonicalSchema,
	uid: numberType().int().positive()
}).strict();
var indexMoveMessage_createServerFn_handler = createServerRpc({
	id: "07e077ac8b4a008c14da044a9e626ad59ce8b84691dca326efc520011a484a2c",
	name: "indexMoveMessage",
	filename: "src/lib/mail-move.functions.ts"
}, (opts) => indexMoveMessage.__executeServer(opts));
var indexMoveMessage = createServerFn({ method: "POST" }).inputValidator((v) => InputSchema.parse(v)).handler(indexMoveMessage_createServerFn_handler, async ({ data }) => {
	const { supabaseAdmin } = await import("./client.server-Bw6iWMJ-.mjs");
	const { verifyMailSessionToken } = await import("./mail-token.server-MkDUXijJ.mjs");
	const { resolveMailConfigForAccount, MailAccountNotFoundError, MailAccountCompanyMismatchError, MailConfigIncompleteError } = await import("./mail-config.server-DiwtRtX7.mjs");
	const { applyMoveWriteThrough, resolveFolderByCanonical, captureSourceFingerprint, discoverDestinationUid, normalizeCanonicalForIndex } = await import("./mail-move-writer.server-BchvkBzO.mjs");
	const { readSyncCursor } = await import("./mail-sync-writer.server-D51lCedV.mjs");
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
		console.error("[indexMoveMessage] resolveConfig failed", e);
		return {
			ok: false,
			error: "تعذر تحميل الإعدادات.",
			code: "CONFIG_LOAD_FAILED"
		};
	}
	const bridgeAccount = {
		email_address: cfg.emailAddress,
		display_name: cfg.displayName,
		imap_host: cfg.imapHost,
		imap_port: cfg.imapPort,
		imap_secure: cfg.imapSecure,
		smtp_host: cfg.smtpHost,
		smtp_port: cfg.smtpPort,
		smtp_secure: cfg.smtpSecure
	};
	const url = processModule.env.MAIL_BRIDGE_URL;
	const key = processModule.env.MAIL_BRIDGE_SECRET;
	if (!url || !key) return {
		ok: false,
		error: "لم يتم ربط خادم البريد.",
		code: "BRIDGE_NOT_CONFIGURED"
	};
	const physicalSourceCanonical = normalizeCanonicalForIndex(data.sourceCanonical);
	normalizeCanonicalForIndex(data.destCanonical);
	return moveMessageOrchestration({
		loadSource: async () => {
			const folder = await resolveFolderByCanonical(supabaseAdmin, accountId, companyId, data.sourceCanonical);
			if (!folder || folder.uidvalidity == null || !folder.path) return null;
			const [cursor, fingerprint] = await Promise.all([readSyncCursor(supabaseAdmin, {
				accountId,
				folderId: folder.id
			}), captureSourceFingerprint(supabaseAdmin, {
				accountId,
				folderId: folder.id,
				uidvalidity: folder.uidvalidity,
				uid: data.uid
			})]);
			return {
				folderId: folder.id,
				uidvalidity: folder.uidvalidity,
				path: folder.path,
				canonical: physicalSourceCanonical,
				cursorNewestSyncedUid: cursor?.newest_synced_uid ?? null,
				fingerprint
			};
		},
		loadDest: async () => {
			const folder = await resolveFolderByCanonical(supabaseAdmin, accountId, companyId, data.destCanonical);
			if (!folder) return {
				folder: null,
				cursorNewestSyncedUid: null
			};
			const cursor = await readSyncCursor(supabaseAdmin, {
				accountId,
				folderId: folder.id
			});
			return {
				folder: {
					id: folder.id,
					uidvalidity: folder.uidvalidity,
					path: folder.path
				},
				cursorNewestSyncedUid: cursor?.newest_synced_uid ?? null
			};
		},
		bridgeMove: async () => {
			try {
				const res = await fetch(`${url.replace(/\/$/, "")}/api/move`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Bridge-Key": key
					},
					body: JSON.stringify({
						account: bridgeAccount,
						password: data.password,
						folder: data.sourceCanonical,
						uid: data.uid,
						toFolder: data.destCanonical
					})
				});
				const text = await res.text();
				let json = {};
				try {
					json = JSON.parse(text);
				} catch {}
				if (!res.ok || !json.ok) return {
					ok: false,
					error: json.error || `Bridge error ${res.status}`,
					code: "BRIDGE_MOVE_FAILED"
				};
				return {
					ok: true,
					move: json.move ?? {
						sourceUid: data.uid,
						uidMappingAvailable: false
					}
				};
			} catch (e) {
				return {
					ok: false,
					error: e instanceof Error ? e.message : "Bridge unreachable",
					code: "BRIDGE_UNREACHABLE"
				};
			}
		},
		applyWriteThrough: async (move) => {
			try {
				const outcome = await applyMoveWriteThrough(supabaseAdmin, {
					accountId,
					companyId,
					sourceCanonical: data.sourceCanonical,
					destCanonical: data.destCanonical,
					sourceUid: data.uid,
					destinationPath: move.destinationPath,
					destinationUid: move.destinationUid,
					destinationUidValidity: move.destinationUidValidity,
					uidMappingAvailable: move.uidMappingAvailable
				});
				if (!outcome.ok) return {
					ok: false,
					error: outcome.error
				};
				return {
					ok: true,
					applied: outcome.applied === "no-source-folder" ? "no-source-folder" : outcome.applied,
					sourceTombstoned: outcome.sourceTombstoned,
					destinationInserted: outcome.destinationInserted
				};
			} catch (e) {
				return {
					ok: false,
					error: e instanceof Error ? e.message : String(e)
				};
			}
		},
		runDestSync: async ({ folderPath, canonical, mode }) => {
			const res = await runMailSyncCore(supabaseAdmin, {
				accountId,
				companyId,
				bridgeAccount,
				password: data.password,
				folderPath,
				canonical,
				mode,
				limit: mode === "initial" ? 300 : 300
			});
			if (!res.ok) return {
				ok: false,
				error: res.error,
				code: res.code
			};
			if (res.busy) return {
				ok: true,
				busy: true
			};
			return {
				ok: true,
				busy: false,
				hasMore: res.hasMore
			};
		},
		reloadDest: async () => {
			const folder = await resolveFolderByCanonical(supabaseAdmin, accountId, companyId, data.destCanonical);
			if (!folder) return {
				folder: null,
				cursorNewestSyncedUid: null
			};
			const cursor = await readSyncCursor(supabaseAdmin, {
				accountId,
				folderId: folder.id
			});
			return {
				folder: {
					id: folder.id,
					uidvalidity: folder.uidvalidity,
					path: folder.path
				},
				cursorNewestSyncedUid: cursor?.newest_synced_uid ?? null
			};
		},
		discoverDest: (params) => discoverDestinationUid(supabaseAdmin, {
			accountId,
			folderId: params.folderId,
			uidvalidity: params.uidvalidity,
			cutoffUid: params.cutoffUid,
			fingerprint: params.fingerprint
		}),
		runSourceReconcile: async ({ folderPath, canonical, uid }) => {
			const res = await runMailSyncCore(supabaseAdmin, {
				accountId,
				companyId,
				bridgeAccount,
				password: data.password,
				folderPath,
				canonical,
				mode: "reconcile",
				fromUid: uid,
				toUid: uid
			});
			if (!res.ok) return {
				ok: false,
				error: res.error,
				code: res.code
			};
			if (res.busy) return {
				ok: true,
				busy: true
			};
			return {
				ok: true,
				busy: false,
				targetUidPresent: res.singleUidPresence ? res.singleUidPresence.present : true
			};
		},
		logError: (label, err) => {
			console.error(label, err instanceof Error ? err.message : String(err));
		}
	}, {
		sourceCanonical: data.sourceCanonical,
		destCanonical: data.destCanonical,
		sourceUid: data.uid
	});
});
//#endregion
export { indexMoveMessage_createServerFn_handler };
