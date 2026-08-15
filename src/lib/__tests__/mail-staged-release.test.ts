import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseStagedHandles } from "../mail-staged-release.browser";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("releaseStagedHandles (best-effort browser release)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dedupes handles and posts exactly once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, released: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const ok = await releaseStagedHandles("token", ["a", "b", "a", "", null, undefined]);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/mail-staged-release");
    const body = JSON.parse(init.body as string);
    expect(body.mailSessionToken).toBe("token");
    expect(body.handles).toEqual(["a", "b"]);
  });

  it("returns true on ok and false on protocol or HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: false })));
    expect(await releaseStagedHandles("t", ["a"])).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );
    expect(await releaseStagedHandles("t", ["a"])).toBe(false);
  });

  it("no-ops on an empty or all-invalid handle list without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await releaseStagedHandles("t", [])).toBe(false);
    expect(await releaseStagedHandles("t", [null, undefined, ""])).toBe(false);
    expect(await releaseStagedHandles("", ["a"])).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the network layer rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(releaseStagedHandles("t", ["a"])).resolves.toBe(false);
  });
});

describe("Composer staged-handle release lifecycle (mail.tsx)", () => {
  const route = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

  it("releases the staged handle when a kept normal attachment is removed", () => {
    const removal = route.slice(
      route.indexOf("function removeExistingAttachment"),
      route.indexOf("function removeFile"),
    );
    expect(removal).toContain("const handle = restoredHandle ?? preservedHandle;");
    expect(removal).toContain("releaseStagedHandle(handle, () => {");
    expect(removal).toContain("restoredHandleByAttachmentIdRef.current.delete(id);");
    expect(removal).toContain("preservedSourceHandlesRef.current.delete(id);");
  });

  it("releases the staged handle when a pending file is removed", () => {
    const removal = route.slice(route.indexOf("function removeFile"), route.indexOf("function exec"));
    expect(removal).toContain('getStagedReady(stagedReadyRef.current, file, "attachment", file.name)');
    expect(removal).toContain("releaseStagedHandle(staged.handle, () => {");
  });

  it("releases the staged handle when an inline image is removed", () => {
    const listener = route.slice(
      route.indexOf("const removed = inlineImagesRef.current.filter"),
      route.indexOf("setInlineImages((current) => current.filter((image) => ids.has(image.id)))"),
    );
    expect(listener).toContain('getStagedReady(');
    expect(listener).toContain("restoredInlineHandlesRef.current.get(image.uploadFilename)");
    expect(listener).toContain("releaseStagedHandle(handle, () => {");
  });

  it("releases all owned staged handles on explicit discard", () => {
    const discard = route.slice(
      route.indexOf("// discard"),
      route.indexOf("// Force clean so beforeunload/guard don't re-trap"),
    );
    expect(discard).toContain("releaseAllOwnedStagedHandles();");
  });

  it("releases all owned staged handles on explicit draft delete", () => {
    const del = route.slice(
      route.indexOf("async function handleDeleteDraft"),
      route.indexOf("return (\n    <div"),
    );
    expect(del).toContain("if (!deleted)");
    expect(del).toContain("releaseAllOwnedStagedHandles();");
  });

  it("does not release staged handles on a failed send (retry keeps client handles)", () => {
    const send = route.slice(
      route.indexOf("async function performSend"),
      route.indexOf("async function handleDeleteDraft"),
    );
    expect(send).toContain("if (!result.ok)");
    expect(send).not.toContain("releaseAllOwnedStagedHandles");
    expect(send).not.toContain("releaseStagedHandle");
    expect(send).not.toContain("releaseStagedHandles");
  });

  it("release helper never fires without a session token", () => {
    const helper = route.slice(
      route.indexOf("function releaseStagedHandle"),
      route.indexOf("function collectOwnedStagedHandles"),
    );
    expect(helper).toContain("const token = mailSessionTokenRef.current;");
    expect(helper).toContain("if (!token) return;");
  });
});
