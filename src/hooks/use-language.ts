import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n, {
  SUPPORTED_LANGS,
  LANG_STORAGE_KEY,
  dirFor,
  getCurrentLang,
  type SupportedLang,
} from "@/i18n";

/**
 * Central language hook. Keeps <html lang/dir> in sync with i18next
 * and exposes a setter that persists to localStorage (handled by the
 * detector) and re-renders subscribers.
 */
export function useLanguage() {
  const { i18n: i18nInst } = useTranslation();
  const [lang, setLangState] = useState<SupportedLang>(() => getCurrentLang());

  useEffect(() => {
    const onChanged = (lng: string) => {
      const two = lng.slice(0, 2) as SupportedLang;
      const next = (SUPPORTED_LANGS as readonly string[]).includes(two) ? two : "ar";
      setLangState(next as SupportedLang);
      if (typeof document !== "undefined") {
        document.documentElement.lang = next;
        document.documentElement.dir = dirFor(next as SupportedLang);
      }
    };
    i18nInst.on("languageChanged", onChanged);
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY)?.slice(0, 2);
    const browser = window.navigator.language.slice(0, 2);
    const preferred = saved || browser;
    const initial = (SUPPORTED_LANGS as readonly string[]).includes(preferred)
      ? (preferred as SupportedLang)
      : "ar";
    if (initial !== getCurrentLang()) {
      void i18nInst.changeLanguage(initial);
    } else {
      onChanged(initial);
    }
    return () => {
      i18nInst.off("languageChanged", onChanged);
    };
  }, [i18nInst]);

  const setLang = useCallback((next: SupportedLang) => {
    window.localStorage.setItem(LANG_STORAGE_KEY, next);
    void i18n.changeLanguage(next);
  }, []);

  return { lang, dir: dirFor(lang), setLang };
}
