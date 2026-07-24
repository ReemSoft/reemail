import { useEffect } from "react";

// Convert a hex like #3B82F6 → "217 91% 60%" (rough HSL string) for CSS var injection.
function hexToHsl(hex: string): string | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export interface CompanyBrand {
  primary?: string | null;
  accent?: string | null;
}

/** Apply company branding by mutating CSS custom properties on <html>. */
export function useCompanyTheme(brand: CompanyBrand | null | undefined) {
  useEffect(() => {
    if (!brand) return;
    const root = document.documentElement;
    const p = brand.primary ? hexToHsl(brand.primary) : null;
    const a = brand.accent ? hexToHsl(brand.accent) : null;
    if (p) root.style.setProperty("--brand", p);
    if (a) {
      root.style.setProperty("--brand-accent", a);
      root.style.setProperty("--primary", a);
      root.style.setProperty("--ring", a);
    }
    return () => {
      root.style.removeProperty("--brand");
      root.style.removeProperty("--brand-accent");
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
    };
  }, [brand?.primary, brand?.accent]);
}
