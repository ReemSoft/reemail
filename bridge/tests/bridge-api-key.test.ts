import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredBridgeApiKeys,
  isBridgeApiKeyAuthorized,
} from "../src/bridge-api-key.js";

test("configuredBridgeApiKeys revokes primary HTTP auth once NEXT is configured", () => {
  assert.deepEqual(
    configuredBridgeApiKeys({
      BRIDGE_API_KEY: "primary-secret",
      BRIDGE_API_KEY_NEXT: "next-secret",
    }),
    ["next-secret"],
  );
});

test("configuredBridgeApiKeys accepts process-env-shaped partial values", () => {
  const env: NodeJS.ProcessEnv = {
    BRIDGE_API_KEY: "primary-secret",
    OTHER_ENV: "ignored",
  };
  assert.deepEqual(configuredBridgeApiKeys(env), ["primary-secret"]);
});

test("configuredBridgeApiKeys ignores blanks and falls back to primary only without NEXT", () => {
  assert.deepEqual(
    configuredBridgeApiKeys({
      BRIDGE_API_KEY: "same-secret",
      BRIDGE_API_KEY_NEXT: " same-secret ",
    }),
    ["same-secret"],
  );
  assert.deepEqual(
    configuredBridgeApiKeys({
      BRIDGE_API_KEY: "primary-secret",
      BRIDGE_API_KEY_NEXT: "   ",
    }),
    ["primary-secret"],
  );
  assert.deepEqual(
    configuredBridgeApiKeys({
      BRIDGE_API_KEY: "   ",
      BRIDGE_API_KEY_NEXT: undefined,
    }),
    [],
  );
});

test("authorization rejects the retired primary when NEXT owns the HTTP boundary", () => {
  const keys = configuredBridgeApiKeys({
    BRIDGE_API_KEY: "primary-secret",
    BRIDGE_API_KEY_NEXT: "next-secret",
  });
  assert.equal(isBridgeApiKeyAuthorized("primary-secret", keys), false);
  assert.equal(isBridgeApiKeyAuthorized("next-secret", keys), true);
  assert.equal(isBridgeApiKeyAuthorized("wrong-secret", keys), false);
  assert.equal(isBridgeApiKeyAuthorized(undefined, keys), false);
  assert.equal(isBridgeApiKeyAuthorized(["next-secret"], keys), false);
  assert.equal(isBridgeApiKeyAuthorized("next-secret", []), false);
});
