import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  entireMessageFlightCount,
  runEntireMessageSingleFlight,
  samePhysicalMessage,
} from "../mail-entire-message";

describe("user-triggered entire-message loading", () => {
  it("single-flights duplicate requests and releases the completed promise", async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const request = () => {
      calls += 1;
      return pending;
    };
    const first = runEntireMessageSingleFlight("tenant|account|inbox|9|77", request);
    const second = runEntireMessageSingleFlight("tenant|account|inbox|9|77", request);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect(entireMessageFlightCount()).toBe(1);
    release("complete");
    await expect(first).resolves.toBe("complete");
    expect(entireMessageFlightCount()).toBe(0);
  });

  it("rejects a late response for another UID or UIDVALIDITY", () => {
    expect(
      samePhysicalMessage(
        { id: "inbox:9", uidValidity: "77" },
        { id: "inbox:9", uidValidity: "77" },
      ),
    ).toBe(true);
    expect(
      samePhysicalMessage(
        { id: "inbox:10", uidValidity: "77" },
        { id: "inbox:9", uidValidity: "77" },
      ),
    ).toBe(false);
    expect(
      samePhysicalMessage(
        { id: "inbox:9", uidValidity: "78" },
        { id: "inbox:9", uidValidity: "77" },
      ),
    ).toBe(false);
  });

  it("renders the action only behind bodyTruncated and supports current and historical state", () => {
    const source = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
    const body = source.slice(
      source.indexOf("function MessageBody("),
      source.indexOf("function TruncatedBodyWarning("),
    );
    const historical = source.slice(
      source.indexOf("function ConversationMessageCard("),
      source.indexOf("function useConversationRows("),
    );
    expect(body).toContain("message.bodyTruncated &&");
    expect(body).toContain("<TruncatedBodyWarning");
    expect(historical).toContain("onEntireBody=");
    expect(source).toContain("onEntireBody={handleEntireBodyLoaded}");
  });

  it("does not automatically call the entire operation or place its result in messageCache", () => {
    const source = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
    const warning = source.slice(
      source.indexOf("function TruncatedBodyWarning("),
      source.indexOf("import {", source.indexOf("function TruncatedBodyWarning(")),
    );
    expect(warning).toContain("onClick={loadEntire}");
    expect(warning).toContain("openEntire({");
    expect(warning).not.toMatch(/useEffect\([\s\S]{0,300}openEntire\(/);
    expect(warning).not.toContain("messageCache");
  });

  it("contains exact Arabic and English labels and failure strings", () => {
    const ar = JSON.parse(
      readFileSync(new URL("../../i18n/locales/ar.json", import.meta.url), "utf8"),
    );
    const en = JSON.parse(
      readFileSync(new URL("../../i18n/locales/en.json", import.meta.url), "utf8"),
    );
    expect(ar["عرض الرسالة كاملة"]).toBe("عرض الرسالة كاملة");
    expect(en["عرض الرسالة كاملة"]).toBe("View entire message");
    expect(ar["جاري تحميل الرسالة كاملة…"]).toBe("جاري تحميل الرسالة كاملة…");
    expect(en["جاري تحميل الرسالة كاملة…"]).toBe("Loading entire message…");
    expect(en["تعذر تحميل الرسالة كاملة. حاول مرة أخرى."]).not.toContain("{{");
  });

  it("server path makes one bridge call and has no persistent body-cache write", () => {
    const source = readFileSync(
      new URL("../mail-message-open.functions.ts", import.meta.url),
      "utf8",
    );
    const entire = source.slice(
      source.indexOf("export const openEntireMailMessage"),
      source.indexOf("const InlinePartSchema"),
    );
    expect(entire.match(/bridgeCallResolved\(/g)).toHaveLength(1);
    expect(entire).toContain('"/api/message-entire"');
    expect(entire).not.toContain("storeCachedBody");
    expect(entire).not.toContain("lookupCachedBody");
  });
});
