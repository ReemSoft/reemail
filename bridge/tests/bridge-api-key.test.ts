import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredBridgeApiKeys,
  isBridgeApiKeyAuthorized,
} from "../src/bridge-api-key.js";

test("configuredBridgeApiKeys supports primary + next auth during rotation", () => {
  assert.deepEqual(
    configuredBridgeApiKeys({
      BRIDGE_API_KEY: "primary-secret",
      BRIDGE_API_KEY_NEXT: "next-secret",
    }),
    ["primary-secret", "next-secret"],
  );
});

test("configuredBridgeApiKeys accepts process-env-shaped partial values", () => {
  const env: NodeJS.ProcessEnv = {
    BRIDGE_API_KEY: "primary-secret",
    OTHER_ENV: "ignored",
  };
  assert.deepEqual(configuredBridgeApiKeys(env), ["primary-secret"]);
});

test("configuredBridgeApiKeys ignores blanks and deduplicates", () => {
  assert.deepEqual(
    configuredBridgeApiKeys({
      BRIDGE_API_KEY: "same-secret",
      BRIDGE_API_KEY_NEXT: " same-secret ",
    }),
    ["same-secret"],
  );
  assert.deepEqual(
    configuredBridgeApiKeys({
      BRIDGE_API_KEY: "   ",
      BRIDGE_API_KEY_NEXT: undefined,
    }),
    [],
  );
});

test("authorization accepts either configured key and rejects other header shapes", () => {
  const keys = ["primary-secret", "next-secret"];
  assert.equal(isBridgeApiKeyAuthorized("primary-secret", keys), true);
  assert.equal(isBridgeApiKeyAuthorized("next-secret", keys), true);
  assert.equal(isBridgeApiKeyAuthorized("wrong-secret", keys), false);
  assert.equal(isBridgeApiKeyAuthorized(undefined, keys), false);
  assert.equal(isBridgeApiKeyAuthorized(["primary-secret"], keys), false);
  assert.equal(isBridgeApiKeyAuthorized("primary-secret", []), false);
});
