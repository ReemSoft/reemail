import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const mail = readFileSync("src/routes/mail.tsx", "utf8");
const browser = readFileSync(
  "src/lib/mail-eml-download.browser.ts",
  "utf8",
);
const open = readFileSync(
  "src/lib/mail-message-open.functions.ts",
  "utf8",
);
const cache = readFileSync(
  "src/lib/mail-body-cache.server.ts",
  "utf8",
);
const bridge = readFileSync("bridge/src/index.ts", "utf8");
const eml = readFileSync("bridge/src/eml-download.ts", "utf8");

test("Download EML is lazy-loaded only by the explicit click handler", () => {
  const start = mail.indexOf("async function downloadEml()");
  const end = mail.indexOf("function printMessage()", start);

  assert.ok(start >= 0);
  assert.ok(end > start);

  const handler = mail.slice(start, end);
  const outside = mail.slice(0, start) + mail.slice(end);

  assert.match(
    handler,
    /import\s*\(\s*"@\/lib\/mail-eml-download\.browser"\s*\)/s,
  );
  assert.doesNotMatch(outside, /mail-eml-download\.browser/);

  const menuItems =
    mail.match(/onClick=\{downloadEml\}/g) ?? [];
  assert.equal(menuItems.length, 1);

  assert.match(
    mail,
    /uiDir === "rtl"\s*\? "تنزيل EML"\s*: "Download EML"/,
  );
});

test("message-open and body-cache remain completely EML-unaware", () => {
  assert.doesNotMatch(
    open,
    /eml-download|mail-eml-ticket|withEmlSourceStream|downloadEmlSource/,
  );
  assert.doesNotMatch(
    cache,
    /eml-download|mail-eml-ticket|withEmlSourceStream|downloadEmlSource/,
  );
});

test("RFC822 bytes stream on the isolated Bridge transfer data plane", () => {
  assert.match(browser, /\/api\/mail-eml-ticket/);
  assert.match(bridge, /purpose:\s*"eml-download"/);
  assert.match(bridge, /\/api\/direct\/eml-download/);

  assert.match(
    eml,
    /getMailboxesCached\(\s*account,\s*password,\s*"transfer"/,
  );

  assert.match(
    eml,
    /client\.download\(/,
  );

  assert.doesNotMatch(
    eml,
    /source:\s*true/,
  );

  assert.match(
    bridge,
    /pipeline\(\s*content,\s*guard,\s*res/s,
  );

  assert.match(
    eml,
    /error instanceof EmlConsumerFailure[\s\S]*ok:\s*false/,
  );

  assert.match(
    eml,
    /if \(outcome\.ok === false\)[\s\S]*throw outcome\.error/,
  );
});
