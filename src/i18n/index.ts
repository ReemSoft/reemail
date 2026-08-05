// i18n bootstrap — natural-language keys (Arabic text IS the key).
// AR is the source-of-truth; EN maps Arabic strings to English.
// Import once (e.g. in __root.tsx) — safe to import in any environment.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ar from "./locales/ar.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGS = ["ar", "en"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];
export const LANG_STORAGE_KEY = "mailmaestro.lang";

// SSR-safe: both server and the first browser render start in Arabic. The saved
// browser preference is applied after hydration by useLanguage.
if (!i18n.isInitialized) {
  const instance = i18n.use(initReactI18next);
  instance.init({
    // All resources are bundled locally. Initialise synchronously so direct
    // `tr` / `trf` calls cannot render an untranslated key on the first pass.
    initAsync: false,
    resources: {
      ar: { translation: ar as Record<string, string> },
      en: { translation: en as Record<string, string> },
    },
    fallbackLng: "ar",
    lng: "ar",
    supportedLngs: SUPPORTED_LANGS,
    load: "languageOnly", // "en-US" → "en"
    // Natural-language keys — Arabic contains dots/colons; disable separators.
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false }, // React handles escaping
    react: { useSuspense: false },
    // If a key is missing in the active resource, use the key itself (Arabic).
    returnEmptyString: false,
    parseMissingKeyHandler: (key) => key,
  });
}

// Framework-free translator so any module can translate without a hook.
export function tr(key: string): string {
  return i18n.t(key) as string;
}

/**
 * Interpolating translator: `trf("تم نقل {{n}} رسالة", { n: 3 })`.
 * Keeps dynamic strings translatable (a template literal can never match a key).
 */
export function trf(key: string, vars: Record<string, string | number>): string {
  return i18n.t(key, vars) as string;
}

export function getCurrentLang(): SupportedLang {
  const lng = (i18n.resolvedLanguage || i18n.language || "ar").slice(0, 2);
  return (SUPPORTED_LANGS as readonly string[]).includes(lng) ? (lng as SupportedLang) : "ar";
}

export function dirFor(lang: SupportedLang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

export default i18n;
