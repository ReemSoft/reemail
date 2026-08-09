// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportPreparedQuotedDocument, markQuotedCidImagesPending } from "@/lib/mail-compose-quote";
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

const meta = { from: { name: "Sender", email: "sender@example.com" }, date: "2026-08-01" };

describe("quoted email preparation", () => {
  it("inlines safe Outlook presentation, preserves order, and removes structural indentation", () => {
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
    ).toHaveLength(0);
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
      expect(editor.querySelector<HTMLImageElement>("[data-mm-remote-image-blocked]")?.src).toBe(
        "",
      );
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
      route.indexOf("const attachRemoteFile"),
      route.indexOf("setInlineImages(hydrated)"),
    );
    expect(hydration).toContain("streamInlineCidPartsSequential");
    expect(hydration).toContain('fetch("/api/mail-inline-part"');
    expect(hydration).toContain("signal,");
    expect(hydration).not.toContain("/api/mail-attachment");
    expect(hydration).not.toMatch(/base64|response\.blob\(/i);

    const formatter = readFileSync("src/lib/mail-compose-quote.ts", "utf8");
    expect(formatter).toContain("\"img-src 'none'\"");
    expect(formatter).toContain("\"connect-src 'none'\"");
    expect(formatter).toContain('frame.setAttribute("sandbox", "allow-same-origin")');
  });
});
