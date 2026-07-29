import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n, {
  SUPPORTED_LANGS,
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
    // Sync once on mount in case detector picked EN before we subscribed.
    onChanged(i18nInst.resolvedLanguage || i18nInst.language || "ar");
    i18nInst.on("languageChanged", onChanged);
    return () => {
      i18nInst.off("languageChanged", onChanged);
    };
  }, [i18nInst]);

  const setLang = useCallback((next: SupportedLang) => {
    void i18n.changeLanguage(next);
  }, []);

  return { lang, dir: dirFor(lang), setLang };
}
