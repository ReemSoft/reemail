import { n as jwtVerify, t as SignJWT } from "../_libs/jose.mjs";
import processModule from "node:process";
//#region node_modules/.nitro/vite/services/ssr/assets/mail-token.server-MkDUXijJ.js
var ISS = "mailmaestro";
var AUD = "mailmaestro-index";
var VER = 1;
var TTL_SECONDS = 720 * 60;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function getSecretKey() {
	const secret = processModule.env.MAIL_SESSION_SECRET;
	if (!secret || secret.length < 32) throw new Error("MAIL_SESSION_SECRET is not configured");
	return new TextEncoder().encode(secret);
}
async function issueMailSessionToken(input) {
	if (!UUID_RE.test(input.accountId)) throw new Error("accountId must be a UUID");
	if (!UUID_RE.test(input.companyId)) throw new Error("companyId must be a UUID");
	if (!input.normalizedEmail || !input.normalizedEmail.includes("@")) throw new Error("normalizedEmail invalid");
	const iat = Math.floor(Date.now() / 1e3);
	const exp = iat + TTL_SECONDS;
	const jti = crypto.randomUUID();
	return {
		token: await new SignJWT({
			ver: VER,
			cid: input.companyId,
			em: input.normalizedEmail
		}).setProtectedHeader({
			alg: "HS256",
			typ: "JWT"
		}).setIssuer(ISS).setAudience(AUD).setSubject(input.accountId).setIssuedAt(iat).setExpirationTime(exp).setJti(jti).sign(getSecretKey()),
		expiresAt: exp
	};
}
async function verifyMailSessionToken(token) {
	const { payload, protectedHeader } = await jwtVerify(token, getSecretKey(), {
		issuer: ISS,
		audience: AUD,
		algorithms: ["HS256"]
	});
	if (protectedHeader.alg !== "HS256") throw new Error("Invalid algorithm");
	if (payload.ver !== VER) throw new Error("Invalid token version");
	const sub = typeof payload.sub === "string" ? payload.sub : "";
	const cid = typeof payload.cid === "string" ? payload.cid : "";
	const em = typeof payload.em === "string" ? payload.em : "";
	if (!UUID_RE.test(sub)) throw new Error("Invalid sub");
	if (!UUID_RE.test(cid)) throw new Error("Invalid cid");
	if (!em || !em.includes("@") || em !== em.toLowerCase().trim()) throw new Error("Invalid em");
	return payload;
}
//#endregion
export { issueMailSessionToken, verifyMailSessionToken };
