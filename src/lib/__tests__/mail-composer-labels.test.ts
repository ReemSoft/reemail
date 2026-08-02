import { afterAll, describe, expect, it } from "vitest";
import i18n, { trf } from "@/i18n";

describe.sequential("composer label interpolation", () => {
  afterAll(async () => {
    await i18n.changeLanguage("ar");
  });

  it("interpolates time and every similar composer placeholder in Arabic", async () => {
    await i18n.changeLanguage("ar");
    const labels = [
      trf("تم الحفظ {{time}}", { time: "10:55 م" }),
      trf("محفوظة محلياً {{time}}", { time: "10:55 م" }),
      trf("الحد الأقصى {{count}} ملفات", { count: 10 }),
      trf("إزالة {{email}}", { email: "person@example.com" }),
      trf("عنوان بريد غير صالح: {{email}}", { email: "bad@example" }),
      trf("تعذّر حفظ المسودّة على الخادم — حاول لاحقاً ({{code}})", {
        code: "IMAP_ERROR",
      }),
    ];

    expect(labels[0]).toBe("تم الحفظ 10:55 م");
    expect(labels.every((label) => !label.includes("{{"))).toBe(true);
  });

  it("uses the approved Arabic recipient plural forms without a literal count token", async () => {
    await i18n.changeLanguage("ar");

    expect(trf("عدد المستلمين", { count: 1 })).toBe("مستلم واحد");
    expect(trf("عدد المستلمين", { count: 2 })).toBe("مستلمان");
    expect(trf("عدد المستلمين", { count: 3 })).toBe("3 مستلمين");
    expect(trf("عدد المستلمين", { count: 11 })).not.toContain("{{count}}");
  });

  it("interpolates time and recipient count in English", async () => {
    await i18n.changeLanguage("en");

    const saved = trf("تم الحفظ {{time}}", { time: "10:55 PM" });
    const one = trf("عدد المستلمين", { count: 1 });
    const many = trf("عدد المستلمين", { count: 3 });

    expect(saved).toBe("Saved 10:55 PM");
    expect(one).toBe("1 recipient");
    expect(many).toBe("3 recipients");
    expect([saved, one, many].every((label) => !label.includes("{{"))).toBe(true);
  });
});
