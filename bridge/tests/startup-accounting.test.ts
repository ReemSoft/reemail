/**
 * Startup accounting barrier (C).
 *
 * The bridge must reconcile staged-attachment counters against disk BEFORE it
 * starts accepting traffic, and fail closed if that init cannot complete. This
 * locks the source contract in bridge/src/index.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const startup = source.slice(
  source.indexOf("async function startServer()"),
  source.indexOf("void startServer()"),
);

test("startup awaits staged-attachment accounting init before app.listen", () => {
  const cleanupIndex = startup.indexOf("await cleanupStagedAttachments()");
  const listenIndex = startup.indexOf("app.listen");
  assert.ok(cleanupIndex !== -1, "startup must await cleanupStagedAttachments()");
  assert.ok(listenIndex !== -1, "startup must call app.listen");
  assert.ok(cleanupIndex < listenIndex, "accounting init must precede app.listen");
});

test("startup fails closed (process.exit(1)) when accounting init throws", () => {
  assert.match(startup, /process\.exit\(1\)/);
  assert.match(startup, /try \{/);
  assert.match(startup, /catch \(error\)/);
});

test("startup still schedules the periodic staged-attachment sweep", () => {
  assert.match(
    startup,
    /setInterval\(\(\) => cleanupStagedAttachments\(\)\.catch\(\(\) => \{\}\), 15 \* 60_000\)\.unref\(\)/,
  );
});

test("startup cleanup uses the default 24h TTL (fresh production .bin files survive)", () => {
  assert.match(startup, /await cleanupStagedAttachments\(\);/);
  assert.doesNotMatch(startup, /await cleanupStagedAttachments\([^)]*,\s*[0-9]/);
});