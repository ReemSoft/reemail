import { n as __toESM } from "../_runtime.mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/use-company-theme-C8pdPbGn.js
var import_react = /* @__PURE__ */ __toESM(require_react());
function hexToHsl(hex) {
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
		s = l > .5 ? d / (2 - max - min) : d / (max + min);
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
/** Apply company branding by mutating CSS custom properties on <html>. */
function useCompanyTheme(brand) {
	(0, import_react.useEffect)(() => {
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
//#endregion
export { useCompanyTheme as t };
