//#region node_modules/.nitro/vite/services/ssr/assets/mail-session-j1dYUlkq.js
var KEY = "mailmaestro.mail.session";
function saveMailSession(session) {
	if (typeof window === "undefined") return;
	sessionStorage.setItem(KEY, JSON.stringify(session));
}
function getMailSession() {
	if (typeof window === "undefined") return null;
	const raw = sessionStorage.getItem(KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
function clearMailSession() {
	if (typeof window === "undefined") return;
	sessionStorage.removeItem(KEY);
}
//#endregion
export { getMailSession as n, saveMailSession as r, clearMailSession as t };
