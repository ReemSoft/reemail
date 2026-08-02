import { afterAll, describe, expect, it } from "vitest";
import i18n, { trf } from "@/i18n";

describe.sequential("MAILMAESTRO_SELECTION_COUNT_INTERPOLATION", () => {
  afterAll(async () => {
    await i18n.changeLanguage("ar");
  });

  it.each([
    [1, "رسالة واحدة محددة"],
    [2, "رسالتان محددتان"],
    [3, "3 رسائل محددة"],
    [11, "11 رسالة محددة"],
  ])("formats Arabic count=%i", async (count, expected) => {
    await i18n.changeLanguage("ar");
    const label = trf("الرسائل المحددة", { count });

    expect(label).toBe(expected);
    expect(label).not.toContain("{{count}}");
  });

  it.each([
    [1, "Selected 1 message"],
    [2, "Selected 2 messages"],
    [3, "Selected 3 messages"],
    [11, "Selected 11 messages"],
  ])("formats English count=%i", async (count, expected) => {
    await i18n.changeLanguage("en");
    const label = trf("الرسائل المحددة", { count });

    expect(label).toBe(expected);
    expect(label).not.toContain("{{count}}");
  });

  it("interpolates every other dynamic label in the mail bulk-action screen", async () => {
    await i18n.changeLanguage("ar");
    const labels = [
      trf("تم استعادة الرسالة إلى {{folder}}", { folder: "الوارد" }),
      trf("فشل نقل {{failed}} من {{total}} رسالة", { failed: 1, total: 3 }),
      trf("تم نقل {{count}} رسالة", { count: 3 }),
      trf("هل أنت متأكد من حذف {{count}} رسالة نهائياً؟ لا يمكن التراجع عن هذا الإجراء.", {
        count: 3,
      }),
      trf("فشل حذف {{failed}} من {{total}} رسالة", { failed: 1, total: 3 }),
      trf("تم نقل {{count}} رسالة إلى المهملات", { count: 3 }),
      trf("فشل استعادة {{failed}} من {{total}} رسالة", { failed: 1, total: 3 }),
      trf("تم تعليم {{count}} رسالة كغير مقروءة", { count: 3 }),
    ];

    expect(labels.every((label) => !label.includes("{{"))).toBe(true);
  });
});
