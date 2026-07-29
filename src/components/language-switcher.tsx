import { useLanguage } from "@/hooks/use-language";
import { Languages } from "lucide-react";

interface Props {
  className?: string;
  compact?: boolean;
}

/**
 * Two-way AR/EN toggle. Persists via i18next-browser-languagedetector
 * (localStorage key: mailmaestro.lang) and flips <html dir> instantly.
 */
export function LanguageSwitcher({ className = "", compact = false }: Props) {
  const { lang, setLang } = useLanguage();
  const isAr = lang === "ar";
  const label = isAr ? "EN" : "AR";
  const title = isAr ? "Switch to English" : "التبديل إلى العربية";

  return (
    <button
      type="button"
      onClick={() => setLang(isAr ? "en" : "ar")}
      title={title}
      aria-label={title}
      className={
        `inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted ${className}`
      }
    >
      <Languages className="h-3.5 w-3.5 opacity-70" />
      {compact ? <span>{label}</span> : <span>{label}</span>}
    </button>
  );
}
