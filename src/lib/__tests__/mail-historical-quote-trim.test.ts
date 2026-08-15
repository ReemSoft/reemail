import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { trimHistoricalQuotedContent } from "@/lib/mail-thread-split";

describe("trimHistoricalQuotedContent", () => {
  it("removes a Gmail quote and its HTML attribution", () => {
    const html =
      '<div>Thanks</div><div class="gmail_attr">On Wed, Ali &lt;<a href="mailto:ali@example.com">ali@example.com</a>&gt; wrote:</div><blockquote class="gmail_quote"><div>old</div></blockquote>';
    expect(trimHistoricalQuotedContent(html)).toBe("<div>Thanks</div>");
  });

  it("removes the Arabic attribution associated with a quote", () => {
    const html =
      '<div>شكرا لكم على الملف<br>شاكرين ومقدرين</div><div dir="rtl">في 4:45 م، 2026/08/12 كتب Hussam Hussam &lt;<a href="mailto:iamhusam@gmail.com">iamhusam@gmail.com</a>&gt;:</div><blockquote><div>تم استلام الملف</div></blockquote>';
    expect(trimHistoricalQuotedContent(html)).toBe(
      "<div>شكرا لكم على الملف<br>شاكرين ومقدرين</div>",
    );
  });

  it("removes an English attribution associated with a quote", () => {
    const html =
      "<p>New answer</p><p>On August 12, Sam &lt;sam@example.com&gt; wrote:</p><blockquote>Old answer</blockquote>";
    expect(trimHistoricalQuotedContent(html)).toBe("<p>New answer</p>");
  });

  it("removes the whole Mail Maestro mm_quote wrapper including its date-first attribution", () => {
    const html =
      '<div>رد جديد</div><div><br></div><div class="mm_quote"><div style="color:#71717a;font-size:12px;margin:0 0 8px"><bdi>15/08/2026, 4:45 م</bdi> — <bdi>Hussam Hussam &lt;iamhusam@gmail.com&gt;</bdi> كتب:</div><blockquote style="margin:0;color:#3f3f46"><div data-mm-quoted-content="1" dir="auto" style="padding-inline-start:12px">تم استلام الملف</div></blockquote></div>';
    expect(trimHistoricalQuotedContent(html)).toBe(
      "<div>رد جديد</div><div><br></div>",
    );
  });

  it("removes an Outlook original-message tail", () => {
    const html =
      "<div>New answer</div><div>-----Original Message-----<br>From: Sam<br>Old answer</div>";
    expect(trimHistoricalQuotedContent(html)).toBe("<div>New answer</div>");
  });

  it("removes a plain-text greater-than quoted tail conservatively", () => {
    const body = "New answer\n\nOn Aug 12, Sam wrote:\n> old line\n> another old line";
    expect(trimHistoricalQuotedContent(body)).toBe("New answer\n");
  });

  it("preserves legitimate Arabic prose containing كتب:", () => {
    const body = "<p>قرأت التقرير الذي كتب: أحمد بعناية، وكانت النتيجة جيدة.</p>";
    expect(trimHistoricalQuotedContent(body)).toBe(body);
  });

  it("preserves legitimate English prose containing wrote:", () => {
    const body = "<p>The note he wrote: yesterday remains relevant.</p>";
    expect(trimHistoricalQuotedContent(body)).toBe(body);
  });

  it("preserves a signature before the quote", () => {
    const html =
      "<p>Thanks<br>Hussam<br>--<br>Hussam Hassan<br>Company Name</p><div>On Wed, Ali wrote:</div><blockquote>Old</blockquote>";
    expect(trimHistoricalQuotedContent(html)).toBe(
      "<p>Thanks<br>Hussam<br>--<br>Hussam Hassan<br>Company Name</p>",
    );
  });

  it("preserves tables, lists and links before the quote", () => {
    const latest =
      '<table><tr><td>Value</td></tr></table><ul><li><a href="https://example.com">Link</a></li></ul>';
    const html = `${latest}<div>On Wed, Ali wrote:</div><blockquote>Old</blockquote>`;
    expect(trimHistoricalQuotedContent(html)).toBe(latest);
  });

  it("returns a message with no quote byte-for-byte unchanged", () => {
    const html = '<div dir="rtl"><b>مرحبا</b> <a href="https://example.com">بكم</a></div>';
    expect(trimHistoricalQuotedContent(html)).toBe(html);
  });
});

describe("Previous Messages display-only wiring", () => {
  const route = readFileSync(resolve(__dirname, "../../routes/mail.tsx"), "utf8");
  const historicalCard = route.slice(
    route.indexOf("function ConversationMessageCard("),
    route.indexOf("function useConversationRows("),
  );

  it("trims only the historical body while preserving attachment rendering", () => {
    expect(historicalCard).toContain("trimHistoricalQuotedContent");
    expect(historicalCard).toContain("<MessageAttachmentsSection message={loaded} />");
  });

  it("does not alter Reply attachment isolation", () => {
    const reply = route.slice(
      route.indexOf("function buildReply"),
      route.indexOf("function buildForward"),
    );
    expect(reply).not.toContain("existingAttachments");
    expect(reply).not.toContain("selectNormalComposerAttachments");
  });
});
