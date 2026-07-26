// Bridge move-contract unit tests. Exercises the pure `parseMoveResponse`
// decoder that maps imapflow's `messageMove` return value into the
// `MoveResult` shape the HTTP endpoint and the Lovable client rely on.
//
// Contract:
//   * UIDPLUS COPYUID response (Map<srcUid,destUid>) → `uidMappingAvailable: true`
//     plus a real `destinationUid` and `destinationUidValidity`.
//   * Non-UIDPLUS response (boolean / empty object) → `uidMappingAvailable: false`
//     and NO fabricated `destinationUid`.
//   * Malformed / unexpected shapes → treated as no-mapping (never throw,
//     never invent a UID).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoveResponse } from "../src/imap.js";

test("UIDPLUS Map response → mapping available with real destination UID", () => {
  const raw = {
    path: "Trash",
    uidValidity: 1700000000n,
    uidMap: new Map<number, number>([[42, 981]]),
  };
  const res = parseMoveResponse(raw, 42, "INBOX");
  assert.equal(res.sourceUid, 42);
  assert.equal(res.destinationPath, "Trash");
  assert.equal(res.destinationUid, 981);
  assert.equal(res.destinationUidValidity, "1700000000");
  assert.equal(res.uidMappingAvailable, true);
});

test("UIDPLUS object-map response → mapping available", () => {
  const raw = { path: "Archive", uidValidity: 99, uidMap: { "7": 555 } };
  const res = parseMoveResponse(raw, 7, "INBOX");
  assert.equal(res.destinationPath, "Archive");
  assert.equal(res.destinationUid, 555);
  assert.equal(res.destinationUidValidity, "99");
  assert.equal(res.uidMappingAvailable, true);
});

test("boolean response (no UIDPLUS) → no mapping, no fabricated UID", () => {
  const res = parseMoveResponse(true, 42, "Trash");
  assert.equal(res.sourceUid, 42);
  assert.equal(res.destinationPath, "Trash");
  assert.equal(res.destinationUid, undefined);
  assert.equal(res.destinationUidValidity, undefined);
  assert.equal(res.uidMappingAvailable, false);
});

test("empty object response → no mapping, fallback path retained", () => {
  const res = parseMoveResponse({}, 42, "Trash");
  assert.equal(res.destinationPath, "Trash");
  assert.equal(res.destinationUid, undefined);
  assert.equal(res.uidMappingAvailable, false);
});

test("uidMap present but missing our source UID → no mapping", () => {
  const raw = { path: "Trash", uidValidity: 1, uidMap: new Map([[99, 100]]) };
  const res = parseMoveResponse(raw, 42, "Trash");
  assert.equal(res.destinationUid, undefined);
  assert.equal(res.uidMappingAvailable, false);
  assert.equal(res.destinationPath, "Trash");
});

test("uidMap with bigint destination value coerces to number", () => {
  const raw = { path: "Trash", uidMap: new Map<number, bigint>([[42, 981n]]) };
  const res = parseMoveResponse(raw, 42, "Trash");
  assert.equal(res.destinationUid, 981);
  assert.equal(res.uidMappingAvailable, true);
});

test("undefined response → no mapping, fallback path only", () => {
  const res = parseMoveResponse(undefined, 42, "Trash");
  assert.equal(res.destinationPath, "Trash");
  assert.equal(res.uidMappingAvailable, false);
});

test("malformed uidMap value → treated as no-mapping, never throws", () => {
  const raw = { path: "Trash", uidMap: { "42": "not-a-number" } };
  const res = parseMoveResponse(raw, 42, "Trash");
  assert.equal(res.destinationUid, undefined);
  assert.equal(res.uidMappingAvailable, false);
});
