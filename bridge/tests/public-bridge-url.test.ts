import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredAppOrigins,
  isAllowedAppOrigin,
  publicBridgeBase,
  type PublicBridgeRequest,
} from "../src/public-bridge-url.js";

function request(protocol: string, host: string, forwardedProtocol?: string): PublicBridgeRequest {
  return {
    protocol,
    get(name) {
      if (name === "host") return host;
      if (name === "x-forwarded-proto") return forwardedProtocol;
      return undefined;
    },
  };
}

test("production origin is allowed by default and random origins are denied", () => {
  const allowed = configuredAppOrigins(undefined);
  assert.equal(isAllowedAppOrigin("https://mailmaestro.online", allowed), true);
  assert.equal(isAllowedAppOrigin("https://attacker.example", allowed), false);
});

test("explicit MAIL_APP_ORIGINS replaces the default with exact origins", () => {
  const allowed = configuredAppOrigins("https://one.example, https://two.example");
  assert.equal(isAllowedAppOrigin("https://one.example", allowed), true);
  assert.equal(isAllowedAppOrigin("https://mailmaestro.online", allowed), false);
});

test("configured public Bridge URL has first priority", () => {
  assert.equal(
    publicBridgeBase(request("http", "internal.invalid"), "https://mailmaestro.reemsoft.com/"),
    "https://mailmaestro.reemsoft.com",
  );
});

test("valid forwarded HTTPS protocol produces a secure public URL", () => {
  assert.equal(
    publicBridgeBase(request("http", "mailmaestro.reemsoft.com", "https"), ""),
    "https://mailmaestro.reemsoft.com",
  );
});

test("invalid forwarded protocol is rejected", () => {
  assert.throws(
    () => publicBridgeBase(request("http", "mailmaestro.reemsoft.com", "javascript"), ""),
    /INVALID_FORWARDED_PROTOCOL/,
  );
});

test("non-local insecure capability URLs and hostile hosts are rejected", () => {
  assert.throws(
    () => publicBridgeBase(request("http", "mailmaestro.reemsoft.com"), ""),
    /INSECURE_PUBLIC_BRIDGE_URL/,
  );
  assert.throws(
    () => publicBridgeBase(request("https", "safe.example/redirect"), ""),
    /INVALID_PUBLIC_BRIDGE_HOST/,
  );
  assert.equal(publicBridgeBase(request("http", "127.0.0.1:3000"), ""), "http://127.0.0.1:3000");
});
