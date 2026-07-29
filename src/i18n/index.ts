// i18n bootstrap — natural-language keys (Arabic text IS the key).
// AR is the source-of-truth; EN maps Arabic strings to English.
// Import once (e.g. in __root.tsx) — safe to import in any environment.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import ar from "./locales/ar.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGS = ["ar", "en"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];
export const LANG_STORAGE_KEY = "mailmaestro.lang";

// SSR-safe: only initialize once, and only add the browser detector on the client.
if (!i18n.isInitialized) {
  const instance = i18n.use(initReactI18next);
  if (typeof window !== "undefined") {
    instance.use(LanguageDetector);
  }
  instance.init({
    resources: {
      ar: { translation: ar as Record<string, string> },
      en: { translation: en as Record<string, string> },
    },
    fallbackLng: "ar",
    supportedLngs: SUPPORTED_LANGS,
    load: "languageOnly", // "en-US" → "en"
    // Natural-language keys — Arabic contains dots/colons; disable separators.
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false }, // React handles escaping
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ["localStorage"],
    },
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

export function getCurrentLang(): SupportedLang {
  const lng = (i18n.resolvedLanguage || i18n.language || "ar").slice(0, 2);
  return (SUPPORTED_LANGS as readonly string[]).includes(lng) ? (lng as SupportedLang) : "ar";
}

export function dirFor(lang: SupportedLang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

export default i18n;
