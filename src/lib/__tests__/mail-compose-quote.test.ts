// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";
import {
  applyQuotedDirectionFallback,
  exportPreparedQuotedDocument,
  markQuotedCidImagesPending,
  removeUnresolvedQuotedCidImage,
} from "@/lib/mail-compose-quote";
import { buildForwardQuoteHtml, buildReplyQuoteHtml } from "@/lib/mail-quote";
import {
  applyInlineImageToCidNodes,
  createInlineComposeImage,
  findInlineImageNodeByCid,
  findInlineImageNodesByCid,
  serializeInlineImages,
} from "@/lib/mail-compose-inline-images";
import { readDraftDoc, writeDraftDoc, type DraftStorageLike } from "@/lib/mail-draft-lifecycle";
import { OUTLOOK_QUOTED_MAIL } from "./fixtures/outlook-quoted-mail";
import { buildEmailHtmlDocument } from "@/lib/mail-compose-html";

const meta = { from: { name: "Sender", email: "sender@example.com" }, date: "2026-08-01" };

describe("quoted email preparation", () => {
  it("drops only an unavailable historical CID while preserving its alt text", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-mm-quoted-content><p>History</p><img src="cid:gone" alt="Company logo"></div>`;
    const image = root.querySelector("img")!;
    expect(removeUnresolvedQuotedCidImage(image)).toBe(true);
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("History");
    expect(root.textContent).toContain("Company logo");
  });

  it("keeps an unresolved current-message image under the strict save fence", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>Current</p><img src="cid:authored">`;
    const image = root.querySelector("img")!;
    expect(removeUnresolvedQuotedCidImage(image)).toBe(false);
    expect(root.querySelector("img")).toBe(image);
  });

  it("adds block-level auto direction only where source direction is missing", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>English paragraph</p>
      <p>فقرة عربية</p>
      <div dir="ltr">Explicit English</div>
      <div dir="rtl">عربي صريح</div>
      <div style="direction:ltr;text-align:right">Styled English</div>
      <div style="direction:rtl;text-align:left">Styled Arabic</div>`;
    applyQuotedDirectionFallback(root);
    const blocks = Array.from(root.children) as HTMLElement[];
    expect(blocks[0]?.getAttribute("dir")).toBe("auto");
    expect(blocks[1]?.getAttribute("dir")).toBe("auto");
    expect(blocks[2]?.getAttribute("dir")).toBe("ltr");
    expect(blocks[3]?.getAttribute("dir")).toBe("rtl");
    expect(blocks[4]?.hasAttribute("dir")).toBe(false);
    expect(blocks[4]?.style.direction).toBe("ltr");
    expect(blocks[4]?.style.textAlign).toBe("right");
    expect(blocks[5]?.hasAttribute("dir")).toBe(false);
    expect(blocks[5]?.style.direction).toBe("rtl");
    expect(blocks[5]?.style.textAlign).toBe("left");
  });

  it("inherits explicit ancestor direction and keeps fallback siblings independent", () => {
    const root = document.createElement("section");
    root.innerHTML = `
      <div dir="rtl"><p>English under RTL</p></div>
      <div style="direction:ltr"><p>مرحبا under LTR</p></div>
      <div dir="rtl"><div dir="ltr"><p>Nearest LTR wins</p></div></div>
      <p>Independent fallback</p>`;
    applyQuotedDirectionFallback(root);
    const explicitParagraphs = root.querySelectorAll("div p");
    expect(
      Array.from(explicitParagraphs).every((paragraph) => !paragraph.hasAttribute("dir")),
    ).toBe(true);
    expect(root.querySelector("div[dir='rtl']")?.getAttribute("dir")).toBe("rtl");
    expect((root.querySelector("div[style]") as HTMLElement | null)?.style.direction).toBe("ltr");
    expect(root.querySelector("div[dir='ltr']")?.getAttribute("dir")).toBe("ltr");
    expect(root.querySelector("div[dir='ltr'] p")?.closest("[dir]")?.getAttribute("dir")).toBe(
      "ltr",
    );
    expect(root.querySelector(":scope > p")?.getAttribute("dir")).toBe("auto");
  });

  it.each(["ltr", "rtl"] as const)(
    "inherits explicit ancestor CSS direction:%s without adding auto",
    (direction) => {
      const root = document.createElement("section");
      root.innerHTML = `<div style="direction:${direction}"><p>Mixed مرحبا text</p></div>`;
      applyQuotedDirectionFallback(root);
      const container = root.querySelector("div") as HTMLElement | null;
      expect(container?.style.direction).toBe(direction);
      expect(container?.hasAttribute("dir")).toBe(false);
      expect(container?.querySelector("p")?.hasAttribute("dir")).toBe(false);
    },
  );

  it("does not treat a MailMaestro fallback ancestor as explicit source direction", () => {
    const root = document.createElement("section");
    root.innerHTML = "<div><p>English</p><p>فقرة عربية</p></div>";
    applyQuotedDirectionFallback(root);
    expect(root.querySelector("div")?.getAttribute("dir")).toBe("auto");
    expect(
      Array.from(root.querySelectorAll("p"), (paragraph) => paragraph.getAttribute("dir")),
    ).toEqual(["auto", "auto"]);
  });

  it("keeps mixed lists and LTR/RTL tables structurally intact", () => {
    document.body.innerHTML = `
      <ul><li>English item</li><li>عنصر عربي</li></ul>
      <table dir="ltr"><tbody><tr><td>English cell</td></tr></tbody></table>
      <table dir="rtl"><tbody><tr><td>خلية عربية</td></tr></tbody></table>`;
    const html = exportPreparedQuotedDocument(document);
    const template = document.createElement("template");
    template.innerHTML = html;
    expect(template.content.querySelectorAll("ul > li")).toHaveLength(2);
    expect(template.content.querySelectorAll("table > tbody > tr > td")).toHaveLength(2);
    expect(template.content.querySelectorAll('table[dir="ltr"]')).toHaveLength(1);
    expect(template.content.querySelectorAll('table[dir="rtl"]')).toHaveLength(1);
    expect(
      Array.from(template.content.querySelectorAll("li")).every(
        (element) => !element.hasAttribute("dir"),
      ),
    ).toBe(true);
    expect(
      Array.from(template.content.querySelectorAll("td")).every(
        (element) => !element.hasAttribute("dir"),
      ),
    ).toBe(true);
  });

  it("preserves source CSS direction and alignment without rewriting neutral blocks", () => {
    document.body.innerHTML = `
      <style>
        .ltr { direction:ltr; text-align:right; }
        .rtl { direction:rtl; text-align:left; }
      </style>
      <p class="ltr">English</p>
      <p class="rtl">عربي</p>
      <p>Automatic</p>`;
    const html = exportPreparedQuotedDocument(document);
    const template = document.createElement("template");
    template.innerHTML = html;
    const paragraphs = Array.from(template.content.querySelectorAll<HTMLElement>("p"));
    expect(paragraphs[0]?.style.direction).toBe("ltr");
    expect(paragraphs[0]?.style.textAlign).toBe("right");
    expect(paragraphs[0]?.hasAttribute("dir")).toBe(false);
    expect(paragraphs[1]?.style.direction).toBe("rtl");
    expect(paragraphs[1]?.style.textAlign).toBe("left");
    expect(paragraphs[1]?.hasAttribute("dir")).toBe(false);
    expect(paragraphs[2]?.hasAttribute("dir")).toBe(false);
    expect(template.content.querySelector("[class],[id]")).toBeNull();
  });

  it("carries document-level body direction into the prepared fragment", () => {
    document.body.setAttribute("dir", "rtl");
    document.body.style.textAlign = "right";
    document.body.innerHTML = "<p>English text under an explicit RTL body</p>";
    const html = exportPreparedQuotedDocument(document);
    const template = document.createElement("template");
    template.innerHTML = html;
    const wrapper = template.content.firstElementChild as HTMLElement | null;
    expect(wrapper?.getAttribute("dir")).toBe("rtl");
    expect(wrapper?.style.textAlign).toBe("right");
    expect(wrapper?.querySelector("p")?.hasAttribute("dir")).toBe(false);
    document.body.removeAttribute("dir");
    document.body.removeAttribute("style");
  });

  it("carries source body typography and spacing instead of inheriting composer defaults", () => {
    document.body.style.fontFamily = "Arial";
    document.body.style.fontSize = "16px";
    document.body.style.lineHeight = "1.25";
    document.body.style.backgroundColor = "rgb(240, 240, 240)";
    document.body.innerHTML = "<table><tbody><tr><td>Original layout</td></tr></tbody></table>";
    const html = exportPreparedQuotedDocument(document);
    const template = document.createElement("template");
    template.innerHTML = html;
    const wrapper = template.content.firstElementChild as HTMLElement | null;
    expect(wrapper?.style.fontFamily).toBe("Arial");
    expect(wrapper?.style.fontSize).toBe("16px");
    expect(wrapper?.style.lineHeight).toBe("1.25");
    expect(wrapper?.style.backgroundColor).toBe("rgb(240, 240, 240)");
    document.body.removeAttribute("style");
  });

  it("keeps LTR body direction inherited by an Arabic child", () => {
    document.body.setAttribute("dir", "ltr");
    document.body.innerHTML = "<p>مرحبا تحت اتجاه صريح</p>";
    const html = exportPreparedQuotedDocument(document);
    const template = document.createElement("template");
    template.innerHTML = html;
    const wrapper = template.content.firstElementChild as HTMLElement | null;
    expect(wrapper?.getAttribute("dir")).toBe("ltr");
    expect(wrapper?.querySelector("p")?.hasAttribute("dir")).toBe(false);
    document.body.removeAttribute("dir");
  });

  it("keeps HTML-level direction inherited by descendants", () => {
    const source = document.implementation.createHTMLDocument("");
    source.documentElement.setAttribute("dir", "rtl");
    source.body.innerHTML = "<div><p>English under HTML RTL</p></div>";
    const html = exportPreparedQuotedDocument(source);
    const template = document.createElement("template");
    template.innerHTML = html;
    const wrapper = template.content.firstElementChild as HTMLElement | null;
    expect(wrapper?.getAttribute("dir")).toBe("rtl");
    expect(wrapper?.querySelector("div")?.hasAttribute("dir")).toBe(false);
    expect(wrapper?.querySelector("p")?.hasAttribute("dir")).toBe(false);
  });

  it("keeps quote direction in draft storage and outgoing email HTML", () => {
    const values = new Map<string, string>();
    const storage: DraftStorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
    const quoteHtml = buildReplyQuoteHtml("Hello", meta, "ar");
    expect(
      writeDraftDoc(storage, "author@example.com", {
        version: 3,
        draftId: "direction-draft",
        snapshot: {
          to: [],
          cc: [],
          bcc: [],
          subject: "Re: Direction",
          html: quoteHtml,
          showCc: false,
          showBcc: false,
        },
        serverRef: null,
        updatedAt: 1,
      }),
    ).toBe(true);
    const reopened = readDraftDoc(storage, "author@example.com");
    expect(reopened?.snapshot.html).toContain('data-mm-quoted-content="1" dir="auto"');
    const sanitized = DOMPurify.sanitize(reopened?.snapshot.html ?? "", {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta", "base", "style"],
      ALLOW_DATA_ATTR: false,
    });
    const outgoing = buildEmailHtmlDocument(sanitized, { dir: "rtl" });
    expect(outgoing).toContain('dir="auto"');
    expect(outgoing).toContain("border-inline-start:2px");
  });

  it("keeps explicit source direction inherited in outgoing HTML", () => {
    const source = document.implementation.createHTMLDocument("");
    source.body.setAttribute("dir", "rtl");
    source.body.innerHTML = "<p>English governed by source RTL</p>";
    const prepared = exportPreparedQuotedDocument(source);
    expect(prepared).toContain('<div dir="rtl"><p>English governed by source RTL</p></div>');
    const editor = document.createElement("div");
    editor.innerHTML = buildReplyQuoteHtml("placeholder", meta, "en");
    const quotedContent = editor.querySelector<HTMLElement>("[data-mm-quoted-content]");
    expect(quotedContent).not.toBeNull();
    if (quotedContent) quotedContent.innerHTML = prepared;
    const outgoing = buildEmailHtmlDocument(DOMPurify.sanitize(editor.innerHTML), { dir: "ltr" });
    expect(outgoing).toContain('dir="rtl"');
    expect(outgoing).toContain("English governed by source RTL");
  });

  it("inlines safe Outlook presentation while preserving order and source whitespace", () => {
    document.body.innerHTML = OUTLOOK_QUOTED_MAIL;
    const html = exportPreparedQuotedDocument(document);
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(html).not.toMatch(/<style|position\s*:\s*fixed|z-index|transform|url\s*\(/i);
    expect(template.content.querySelector('[title="greeting"]')?.getAttribute("style")).toMatch(
      /margin|padding|color/,
    );
    expect(template.content.querySelector('[title="summary"] tbody tr td')).not.toBeNull();
    expect(
      Array.from(
        template.content.querySelectorAll(
          '[title="greeting"],[title="summary"],[title="information"],[title="signature"]',
        ),
        (node) => node.getAttribute("title"),
      ),
    ).toEqual(["greeting", "summary", "information", "signature"]);
    expect(template.content.querySelector("[class],[id]")).toBeNull();
    expect(
      Array.from(template.content.querySelectorAll("table,tbody,tr")).flatMap((node) =>
        Array.from(node.childNodes).filter(
          (child) => child.nodeType === Node.TEXT_NODE && !child.textContent?.trim(),
        ),
      ),
    ).not.toHaveLength(0);
  });

  it("strips hostile app-colliding classes and source ids after preserving safe presentation", () => {
    document.body.innerHTML = `
      <style>.MsoNormal { color: rgb(12, 34, 56); font-size: 15px; }</style>
      <a href="#target">jump</a>
      <div id="target" class="flex fixed hidden grid absolute w-full MsoNormal"
           style="position:absolute;transform:scale(5)">Text</div>`;
    const html = exportPreparedQuotedDocument(document);
    const template = document.createElement("template");
    template.innerHTML = html;
    const content = template.content.querySelector("div");
    expect(content?.textContent).toBe("Text");
    expect(content?.hasAttribute("class")).toBe(false);
    expect(content?.hasAttribute("id")).toBe(false);
    expect(content?.getAttribute("style")).toMatch(/color|font-size/);
    expect(content?.getAttribute("style")).not.toMatch(/position|transform/);
    expect(template.content.querySelector("a")?.hasAttribute("href")).toBe(false);

    const initialReply = markQuotedCidImagesPending(
      buildReplyQuoteHtml(
        '<div class="flex fixed hidden grid absolute w-full" id="source">Text</div>',
        meta,
        "en",
      ),
    );
    const initialTemplate = document.createElement("template");
    initialTemplate.innerHTML = initialReply;
    expect(initialTemplate.content.querySelector(".mm_quote")).not.toBeNull();
    expect(
      initialTemplate.content.querySelector(
        "[data-mm-quoted-content] [class],[data-mm-quoted-content] [id]",
      ),
    ).toBeNull();
  });

  it("blocks HTTPS and protocol-relative tracker images before live Composer insertion", () => {
    const html = markQuotedCidImagesPending(`
      <table><tr><td>
        <img src="https://tracker.example/pixel.png" srcset="https://tracker.example/2x.png 2x" width="1" height="1">
        <img src="//tracker.example/pixel.png" width="2" height="2">
      </td></tr></table>`);
    const template = document.createElement("template");
    template.innerHTML = html;
    const images = Array.from(template.content.querySelectorAll<HTMLImageElement>("img"));
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.hasAttribute("src")).toBe(false);
      expect(image.hasAttribute("srcset")).toBe(false);
      expect(image.dataset.mmRemoteImageBlocked).toBe("1");
      expect(image.style.visibility).toBe("hidden");
    }
    expect(html).not.toMatch(/(?:src|srcset)=["'](?:https?:)?\/\//i);
  });

  it("preserves the classified remote URL inertly without a live src", () => {
    const html = markQuotedCidImagesPending(
      '<img src="https://tracker.example/pixel.png" srcset="https://tracker.example/2x.png 2x" width="1" height="1">',
    );
    const template = document.createElement("template");
    template.innerHTML = html;
    const image = template.content.querySelector<HTMLImageElement>("img");
    expect(image?.hasAttribute("src")).toBe(false);
    expect(image?.hasAttribute("srcset")).toBe(false);
    expect(image?.dataset.mmRemoteImageUrl).toBe("https://tracker.example/pixel.png");
    expect(image?.dataset.mmRemoteImageBlocked).toBe("1");
    expect(html).toContain('data-mm-remote-image-url="https://tracker.example/pixel.png"');
    expect(html).not.toMatch(/<img[^>]*\ssrc=/i);
  });

  it("serializes blocked remote images back to their exact safe URL on the detached copy", () => {
    const editor = document.createElement("div");
    editor.innerHTML =
      '<p>a</p><img data-mm-remote-image-blocked="1" data-mm-remote-image-url="https://cdn.example/img.png" style="visibility:hidden" aria-hidden="true" width="40"><p>b</p>';
    const result = serializeInlineImages(editor.innerHTML, []);
    expect(result.html).toContain('src="https://cdn.example/img.png"');
    expect(result.html).not.toContain("data-mm-remote-image");
    expect(result.html).not.toContain("aria-hidden");
    expect(result.html).not.toContain("visibility");
    expect(result.html).toContain('width="40"');
    expect(editor.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it("restores protocol-relative and http remote URLs in outgoing HTML", () => {
    const editor = document.createElement("div");
    editor.innerHTML =
      '<img data-mm-remote-image-blocked="1" data-mm-remote-image-url="//tracker.example/p.png"><img data-mm-remote-image-url="http://legacy.example/i.png">';
    const result = serializeInlineImages(editor.innerHTML, []);
    expect(result.html).toContain('src="//tracker.example/p.png"');
    expect(result.html).toContain('src="http://legacy.example/i.png"');
  });

  it("removes blocked images whose preserved URL is missing or unsafe instead of a broken img", () => {
    const editor = document.createElement("div");
    editor.innerHTML =
      '<img data-mm-remote-image-blocked="1" width="10"><img data-mm-remote-image-url="javascript:alert(1)"><img data-mm-remote-image-url="data:image/png;base64,AA=="><img data-mm-remote-image-url="https://ok.example/x.png">';
    const result = serializeInlineImages(editor.innerHTML, []);
    expect(result.html.match(/<img\b/g)).toHaveLength(1);
    expect(result.html).toContain('src="https://ok.example/x.png"');
    expect(result.html).not.toContain("javascript:");
    expect(result.html).not.toContain("data:image");
  });

  it("keeps the blocked state in a keepEditorIds draft snapshot (no live src)", () => {
    const editor = document.createElement("div");
    editor.innerHTML =
      '<img data-mm-remote-image-blocked="1" data-mm-remote-image-url="https://cdn.example/img.png" style="visibility:hidden" aria-hidden="true">';
    const draft = serializeInlineImages(editor.innerHTML, [], { keepEditorIds: true });
    expect(draft.html).toContain('data-mm-remote-image-url="https://cdn.example/img.png"');
    expect(draft.html).not.toMatch(/<img[^>]*\ssrc=/i);
  });

  it("preserves and restores remote images for both Reply and Forward quotes", () => {
    const source = '<img src="https://cdn.example/logo.png" width="80">';
    const reply = markQuotedCidImagesPending(buildReplyQuoteHtml(source, meta, "en"));
    const forward = markQuotedCidImagesPending(buildForwardQuoteHtml(source, meta, "en"));
    for (const html of [reply, forward]) {
      const serialized = serializeInlineImages(html, []);
      expect(serialized.html).toContain('src="https://cdn.example/logo.png"');
      expect(serialized.html).not.toContain("data-mm-remote-image");
      expect(serialized.html).not.toContain("aria-hidden");
      expect(serialized.html).not.toContain("visibility");
    }
  });

  it("leaves CID hydration and data:/blob: safety unchanged while restoring remote URLs", () => {
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:unchanged-logo";
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
      const hydrated = createInlineComposeImage(file);
      const editor = document.createElement("div");
      editor.innerHTML = [
        `<img src="${hydrated.objectUrl}" data-mm-inline-id="${hydrated.id}" data-mm-source-cid="old@example">`,
        '<img src="data:image/png;base64,AA==">',
        '<img src="blob:not-hydrated">',
        '<img data-mm-remote-image-blocked="1" data-mm-remote-image-url="https://cdn.example/x.png">',
      ].join("");
      const result = serializeInlineImages(editor.innerHTML, [hydrated]);
      expect(result.html).toContain(`src="cid:${hydrated.cid}"`);
      expect(result.html).not.toContain("data:image");
      expect(result.html).not.toContain("blob:");
      expect(result.html).not.toContain("data-mm-source-cid");
      expect(result.html).toContain('src="https://cdn.example/x.png"');
      expect(result.inlineImages).toHaveLength(1);
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it("keeps the editor pre-wrap contract isolated from a normal-whitespace quote", () => {
    const reply = buildReplyQuoteHtml("<p>Old</p>", meta, "en");
    const forward = buildForwardQuoteHtml("<p>Old</p>", meta, "en");
    expect(reply).toContain("white-space:normal");
    expect(forward).toContain("white-space:normal");
    const route = readFileSync("src/routes/mail.tsx", "utf8");
    expect(route).toContain("whitespace-pre-wrap");
  });

  it("hides raw CID URLs, matches casing/brackets, and omits unresolved images", () => {
    const pending = markQuotedCidImagesPending(
      '<table><tr><td><img src="cid:ABC@Example" width="120" height="40"></td></tr></table>',
    );
    const editor = document.createElement("div");
    editor.innerHTML = pending;
    const image = findInlineImageNodeByCid(editor, "<abc@example>");
    expect(image?.hasAttribute("src")).toBe(false);
    expect(image?.style.visibility).toBe("hidden");
    expect(serializeInlineImages(editor.innerHTML, []).html).not.toContain("<img");
  });

  it("serializes a hydrated quoted image as a new outgoing CID", () => {
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:quoted-logo";
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
      const hydrated = createInlineComposeImage(file);
      const html = `<img src="${hydrated.objectUrl}" data-mm-inline-id="${hydrated.id}" data-mm-source-cid="old-logo@example">`;
      const result = serializeInlineImages(html, [hydrated]);
      expect(result.html).toContain(`src="cid:${hydrated.cid}"`);
      expect(result.html).not.toContain("old-logo@example");
      expect(result.inlineImages).toEqual([
        expect.objectContaining({ cid: hydrated.cid, mimeType: "image/png" }),
      ]);
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it("reveals a cached small CID as an object URL without rebuilding its table", () => {
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:cached-logo";
    try {
      const editor = document.createElement("div");
      editor.innerHTML = markQuotedCidImagesPending(
        '<table><tbody><tr><td title="cell"><img src="cid:logo@example" width="180"></td></tr></tbody></table>',
      );
      const image = createInlineComposeImage(
        new File([new Uint8Array([1])], "logo.png", { type: "image/png" }),
      );
      expect(applyInlineImageToCidNodes(editor, "<LOGO@example>", image)).toBe(1);
      const node = editor.querySelector<HTMLImageElement>("img");
      expect(node?.src).toContain("blob:cached-logo");
      expect(node?.style.visibility).toBe("");
      expect(node?.dataset.mmInlineId).toBe(image.id);
      expect(editor.querySelector('[title="cell"]')?.contains(node ?? null)).toBe(true);
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it("hydrates every repeated CID occurrence and serializes one attachment identity", () => {
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:repeated-logo";
    try {
      const editor = document.createElement("div");
      editor.innerHTML = markQuotedCidImagesPending(
        '<img src="cid:logo@example" width="120"><p>text</p><img src="cid:LOGO@example" width="240">',
      );
      const image = createInlineComposeImage(
        new File([new Uint8Array([1, 2])], "logo.png", { type: "image/png" }),
      );
      expect(findInlineImageNodesByCid(editor, "<logo@example>")).toHaveLength(2);
      expect(applyInlineImageToCidNodes(editor, "<logo@example>", image)).toBe(2);
      const nodes = Array.from(editor.querySelectorAll<HTMLImageElement>("img"));
      expect(nodes.map((node) => node.dataset.mmInlineId)).toEqual([image.id, image.id]);
      expect(nodes.map((node) => node.getAttribute("width"))).toEqual(["120", "240"]);
      expect(editor.children[1]?.textContent).toBe("text");

      const serialized = serializeInlineImages(editor.innerHTML, [image]);
      expect(serialized.html.match(new RegExp(`cid:${image.cid}`, "g"))).toHaveLength(2);
      expect(serialized.inlineImages).toHaveLength(1);
      expect(serialized.inlineImages[0]?.cid).toBe(image.cid);
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it("handles a mixed repeated small CID, large CID, and blocked remote tracker", () => {
    const originalCreate = URL.createObjectURL;
    let sequence = 0;
    URL.createObjectURL = () => `blob:mixed-${++sequence}`;
    try {
      document.body.innerHTML = `
        <style>.signature { padding: 8px; } table { width: 100%; }</style>
        <table class="grid"><tr><td>
          <img src="cid:small@example" width="80">
          <span>signature</span>
          <img src="cid:SMALL@example" width="160">
          <img src="cid:large@example" width="320">
          <img src="https://tracker.example/pixel.png" width="1" height="1">
        </td></tr></table>`;
      const editor = document.createElement("div");
      editor.innerHTML = exportPreparedQuotedDocument(document);
      const small = createInlineComposeImage(
        new File([new Uint8Array(128)], "small.png", { type: "image/png" }),
      );
      const large = createInlineComposeImage(
        new File([new Uint8Array(Math.round(1.8 * 1024 * 1024))], "large.png", {
          type: "image/png",
        }),
      );
      expect(applyInlineImageToCidNodes(editor, "small@example", small)).toBe(2);
      expect(applyInlineImageToCidNodes(editor, "large@example", large)).toBe(1);
      expect(editor.querySelector("[class],[id]")).toBeNull();
      expect(
        editor.querySelector<HTMLImageElement>('img[src^="https://tracker.example/"]'),
      ).not.toBeNull();
      const serialized = serializeInlineImages(editor.innerHTML, [small, large]);
      expect(serialized.inlineImages).toHaveLength(2);
      expect(serialized.html.match(new RegExp(`cid:${small.cid}`, "g"))).toHaveLength(2);
      expect(serialized.html).toContain(`cid:${large.cid}`);
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it("round-trips quoted CID HTML and metadata through the existing draft document", () => {
    const values = new Map<string, string>();
    const storage: DraftStorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
    const inlineImages = [
      {
        id: "quoted-logo",
        cid: "mm-inline-quoted-logo@mailmaestro",
        mimeType: "image/png" as const,
        filename: "logo.png",
        uploadFilename: "mm-inline-quoted-logo.png",
      },
    ];
    expect(
      writeDraftDoc(storage, "author@example.com", {
        version: 3,
        draftId: "reply-draft",
        snapshot: {
          to: [],
          cc: [],
          bcc: [],
          subject: "Re: Project",
          html: '<blockquote><img src="cid:mm-inline-quoted-logo@mailmaestro" data-mm-inline-id="quoted-logo"></blockquote>',
          showCc: false,
          showBcc: false,
          inlineImages,
        },
        serverRef: null,
        updatedAt: 1,
      }),
    ).toBe(true);
    const reopened = readDraftDoc(storage, "author@example.com");
    expect(reopened?.snapshot.html).toContain('data-mm-inline-id="quoted-logo"');
    expect(reopened?.snapshot.inlineImages).toEqual(inlineImages);
  });
});

describe("reply/forward source hydration wiring", () => {
  it("propagates CID metadata and streams large parts through the dedicated endpoint", () => {
    const route = readFileSync("src/routes/mail.tsx", "utf8");
    const replyForward = route.slice(
      route.indexOf("function buildReply"),
      route.indexOf("const UUID_RE"),
    );
    expect(replyForward.match(/inlineParts: message\.inlineParts/g)).toHaveLength(2);
    expect(replyForward.match(/inlineImages: message\.inlineImages/g)).toHaveLength(2);
    expect(replyForward.match(/inlineMessageId: message\.id/g)).toHaveLength(2);

    const hydration = route.slice(
      route.indexOf("const hydrate = async () =>"),
      route.indexOf("inlineReadinessRef.current = hydrate()"),
    );
    // Working Drafts hydrate only their owned inline objects, while the
    // provider-Draft compatibility path retains protected CID-part streaming.
    expect(hydration).toContain('fetch("/api/mail-working-draft-attachment-content"');
    expect(hydration).toContain("streamInlineCidPartsSequential");
    expect(hydration).toContain('fetch("/api/mail-inline-part"');
    expect(hydration).toContain("signal,");
    expect(hydration).not.toContain("/api/mail-attachment");

    const formatter = readFileSync("src/lib/mail-compose-quote.ts", "utf8");
    expect(formatter).toContain("\"img-src 'none'\"");
    expect(formatter).toContain("\"connect-src 'none'\"");
    expect(formatter).toContain('frame.setAttribute("sandbox", "allow-same-origin")');
  });
});
