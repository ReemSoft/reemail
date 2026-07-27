import { applyFlagStates, claimSyncLock, ensureFolderRow, readSyncCursor, refreshFolderCounts, releaseSyncLock, shouldWipeForUidValidity, tombstoneMissingInRange, updateSyncCursor, upsertMessagesInBatches, wipeFolderForUidValidityReset, writeFolderMailboxState } from "./mail-sync-writer.server-D51lCedV.mjs";
import processModule from "node:process";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-sync-runner.server-Ct6EWo-P.js
var BRIDGE_TTL_SECONDS = 60;
/**
* Pure helper — extracted so we can unit-test the reconcile presence
* derivation without wiring a full Bridge + DB fake. Returns `undefined`
* when the range is not a 1-UID reconcile (contract: only 1-UID reconcile
* yields a `singleUidPresence`).
*/
function derivePresenceForSingleUidReconcile(fromUid, toUid, states) {
	if (fromUid !== toUid) return void 0;
	return {
		uid: fromUid,
		present: states.some((s) => s.uid === fromUid)
	};
}
async function defaultBridgePost(path, payload) {
	const url = processModule.env.MAIL_BRIDGE_URL;
	const key = processModule.env.MAIL_BRIDGE_SECRET;
	if (!url || !key) throw new Error("BRIDGE_NOT_CONFIGURED");
	const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Bridge-Key": key
		},
		body: JSON.stringify(payload)
	});
	const text = await res.text();
	let json = {};
	try {
		json = JSON.parse(text);
	} catch {}
	if (!res.ok) {
		const errCode = json.error || `BRIDGE_HTTP_${res.status}`;
		throw new Error(errCode);
	}
	return json;
}
/**
* Core sync engine. Callers are expected to have already resolved the
* mail-account config and (in the client-facing path) verified the mail
* session token. `bridgePost` is injectable to keep the engine testable
* without a live Bridge; production callers pass no override.
*/
async function runMailSyncCore(admin, input, bridgePost = defaultBridgePost) {
	const { folderId, storedUidValidity } = await ensureFolderRow(admin, {
		accountId: input.accountId,
		companyId: input.companyId,
		path: input.folderPath,
		canonical: input.canonical ?? null
	});
	const lockedBy = `sync:${crypto.randomUUID()}`;
	if (!await claimSyncLock(admin, {
		accountId: input.accountId,
		companyId: input.companyId,
		folderId,
		lockedBy,
		ttlSeconds: BRIDGE_TTL_SECONDS
	})) return {
		ok: true,
		busy: true,
		reason: "LOCKED"
	};
	let releaseStatus = "idle";
	let releaseErrCode = null;
	let releaseErrMsg = null;
	try {
		const cursor = await readSyncCursor(admin, {
			accountId: input.accountId,
			folderId
		});
		let wipedForUidValidity = false;
		let wroteMessages = 0;
		let appliedFlagChanges = 0;
		let tombstoned = 0;
		let hasMore = false;
		let flagsSync = "not-requested";
		let mailboxUidValidity;
		let mailboxUidNext = null;
		let mailboxHighestModseq = null;
		let mailboxExists = 0;
		let singleUidPresence;
		if (input.mode === "initial") {
			const result = await bridgePost("/api/sync/initial", {
				account: input.bridgeAccount,
				password: input.password,
				folderPath: input.folderPath,
				limit: input.limit ?? 300
			});
			mailboxUidValidity = result.mailbox.uidValidity;
			mailboxUidNext = result.mailbox.uidNext;
			mailboxHighestModseq = result.mailbox.highestModseq;
			mailboxExists = result.mailbox.exists;
			if (shouldWipeForUidValidity(storedUidValidity, mailboxUidValidity)) {
				await wipeFolderForUidValidityReset(admin, {
					accountId: input.accountId,
					companyId: input.companyId,
					folderId,
					newUidValidity: mailboxUidValidity
				});
				wipedForUidValidity = true;
			}
			wroteMessages = await upsertMessagesInBatches(admin, {
				accountId: input.accountId,
				companyId: input.companyId,
				folderId,
				uidValidity: mailboxUidValidity
			}, result.messages);
			await updateSyncCursor(admin, {
				accountId: input.accountId,
				folderId,
				uidValidity: mailboxUidValidity,
				uidNext: mailboxUidNext,
				highestModseq: mailboxHighestModseq,
				oldestSyncedUid: result.oldestReturnedUid,
				newestSyncedUid: result.newestReturnedUid,
				flagsNeedReconcile: false
			});
		} else if (input.mode === "incremental") {
			if (!cursor || cursor.newest_synced_uid == null || cursor.uidvalidity == null) return {
				ok: false,
				error: "لم يتم إجراء مزامنة أولية بعد.",
				code: "NO_CURSOR"
			};
			const flagsFrom = input.flagsFromUid ?? Math.max(1, cursor.newest_synced_uid - 500);
			const flagsTo = input.flagsToUid ?? cursor.newest_synced_uid;
			const result = await bridgePost("/api/sync/incremental", {
				account: input.bridgeAccount,
				password: input.password,
				folderPath: input.folderPath,
				expectedUidValidity: cursor.uidvalidity,
				sinceUid: cursor.newest_synced_uid,
				sinceModseq: cursor.highest_modseq ?? void 0,
				flagsFromUid: flagsFrom,
				flagsToUid: flagsTo,
				limit: input.limit ?? 300
			});
			mailboxUidValidity = result.mailbox.uidValidity;
			mailboxUidNext = result.mailbox.uidNext;
			mailboxHighestModseq = result.mailbox.highestModseq;
			mailboxExists = result.mailbox.exists;
			if (result.resetRequired) {
				await wipeFolderForUidValidityReset(admin, {
					accountId: input.accountId,
					companyId: input.companyId,
					folderId,
					newUidValidity: mailboxUidValidity
				});
				wipedForUidValidity = true;
				await updateSyncCursor(admin, {
					accountId: input.accountId,
					folderId,
					uidValidity: mailboxUidValidity,
					uidNext: mailboxUidNext,
					highestModseq: mailboxHighestModseq,
					oldestSyncedUid: null,
					newestSyncedUid: null,
					flagsNeedReconcile: false
				});
			} else {
				const messages = result.newMessages ?? [];
				wroteMessages = await upsertMessagesInBatches(admin, {
					accountId: input.accountId,
					companyId: input.companyId,
					folderId,
					uidValidity: mailboxUidValidity
				}, messages);
				appliedFlagChanges = await applyFlagStates(admin, {
					accountId: input.accountId,
					folderId,
					uidValidity: mailboxUidValidity
				}, result.flagChanges ?? []);
				hasMore = !!result.hasMore;
				flagsSync = result.flagsSync ?? "not-requested";
				const newestFromBatch = messages.length ? messages[messages.length - 1].uid : null;
				const nextNewest = Math.max(cursor.newest_synced_uid ?? 0, result.nextSinceUid ?? 0, newestFromBatch ?? 0);
				await updateSyncCursor(admin, {
					accountId: input.accountId,
					folderId,
					uidValidity: mailboxUidValidity,
					uidNext: mailboxUidNext,
					highestModseq: mailboxHighestModseq,
					oldestSyncedUid: cursor.oldest_synced_uid,
					newestSyncedUid: nextNewest > 0 ? nextNewest : null,
					flagsNeedReconcile: flagsSync === "reconcile-required" ? true : null
				});
			}
		} else {
			if (!cursor || cursor.uidvalidity == null) return {
				ok: false,
				error: "لا توجد حالة مزامنة سابقة لهذا المجلد.",
				code: "NO_CURSOR"
			};
			const RECONCILE_MAX_RANGE = 1e3;
			const requestedFrom = input.fromUid ?? cursor.oldest_synced_uid ?? 1;
			const toUid = input.toUid ?? cursor.newest_synced_uid ?? requestedFrom;
			const fromUid = Math.max(requestedFrom, toUid - (RECONCILE_MAX_RANGE - 1));
			if (toUid < fromUid) return {
				ok: false,
				error: "نطاق التوفيق غير صالح.",
				code: "INVALID_RANGE"
			};
			const result = await bridgePost("/api/sync/reconcile", {
				account: input.bridgeAccount,
				password: input.password,
				folderPath: input.folderPath,
				expectedUidValidity: cursor.uidvalidity,
				fromUid,
				toUid
			});
			mailboxUidValidity = result.mailbox.uidValidity;
			mailboxUidNext = result.mailbox.uidNext;
			mailboxHighestModseq = result.mailbox.highestModseq;
			mailboxExists = result.mailbox.exists;
			if (result.resetRequired) {
				await wipeFolderForUidValidityReset(admin, {
					accountId: input.accountId,
					companyId: input.companyId,
					folderId,
					newUidValidity: mailboxUidValidity
				});
				wipedForUidValidity = true;
				await updateSyncCursor(admin, {
					accountId: input.accountId,
					folderId,
					uidValidity: mailboxUidValidity,
					uidNext: mailboxUidNext,
					highestModseq: mailboxHighestModseq,
					oldestSyncedUid: null,
					newestSyncedUid: null,
					flagsNeedReconcile: false
				});
			} else {
				const states = result.states ?? [];
				appliedFlagChanges = await applyFlagStates(admin, {
					accountId: input.accountId,
					folderId,
					uidValidity: mailboxUidValidity
				}, states);
				tombstoned = await tombstoneMissingInRange(admin, {
					accountId: input.accountId,
					folderId,
					uidValidity: mailboxUidValidity,
					fromUid,
					toUid,
					presentUids: states.map((s) => s.uid)
				});
				singleUidPresence = derivePresenceForSingleUidReconcile(fromUid, toUid, states);
				await updateSyncCursor(admin, {
					accountId: input.accountId,
					folderId,
					uidValidity: mailboxUidValidity,
					uidNext: mailboxUidNext,
					highestModseq: mailboxHighestModseq,
					oldestSyncedUid: cursor.oldest_synced_uid,
					newestSyncedUid: cursor.newest_synced_uid,
					flagsNeedReconcile: false,
					markReconciledAt: true
				});
			}
		}
		await writeFolderMailboxState(admin, folderId, {
			path: input.folderPath,
			exists: mailboxExists,
			uidValidity: mailboxUidValidity,
			uidNext: mailboxUidNext,
			highestModseq: mailboxHighestModseq
		});
		const counts = await refreshFolderCounts(admin, {
			accountId: input.accountId,
			folderId,
			uidValidity: mailboxUidValidity,
			authoritativeTotal: mailboxExists
		});
		const finalCursor = await readSyncCursor(admin, {
			accountId: input.accountId,
			folderId
		});
		return {
			ok: true,
			busy: false,
			mode: input.mode,
			folderId,
			folderPath: input.folderPath,
			wroteMessages,
			appliedFlagChanges,
			tombstoned,
			wipedForUidValidity,
			total: counts.total,
			unread: counts.unread,
			uidvalidity: mailboxUidValidity,
			newestSyncedUid: finalCursor?.newest_synced_uid ?? null,
			oldestSyncedUid: finalCursor?.oldest_synced_uid ?? null,
			hasMore,
			flagsSync,
			...singleUidPresence ? { singleUidPresence } : {}
		};
	} catch (err) {
		releaseStatus = "error";
		const raw = err instanceof Error ? err.message : String(err ?? "");
		releaseErrCode = /^[A-Z0-9_]+$/.test(raw) ? raw : "SYNC_FAILED";
		releaseErrMsg = raw.slice(0, 300);
		console.error("[runMailSyncCore] sync failed", releaseErrCode);
		return {
			ok: false,
			error: "فشل تشغيل المزامنة.",
			code: releaseErrCode
		};
	} finally {
		try {
			await releaseSyncLock(admin, {
				accountId: input.accountId,
				companyId: input.companyId,
				folderId,
				lockedBy,
				status: releaseStatus,
				errorCode: releaseErrCode,
				errorMessage: releaseErrMsg
			});
		} catch (releaseErr) {
			console.error("[runMailSyncCore] release lock failed", releaseErr);
		}
	}
}
//#endregion
export { runMailSyncCore };
