// Server-only. Never import from client components or `.functions.ts` at top level.
// This file signs & verifies short-lived Mail Session Tokens (HS256 via jose).
import { SignJWT, jwtVerify } from "jose";

const ISS = "mailmaestro";
const AUD = "mailmaestro-index";
const VER = 1;
const TTL_SECONDS = 12 * 60 * 60; // 12h

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MailSessionClaims {
  sub: string; // mail_accounts.id (UUID)
  cid: string; // company_id (UUID)
  em: string; // normalized email
  iat: number;
  exp: number;
  jti: string;
  iss: string;
  aud: string;
  ver: number;
}

function getSecretKey(): Uint8Array {
  const secret = process.env.MAIL_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    // Fail closed — never fall back to a static default.
    throw new Error("MAIL_SESSION_SECRET is not configured");
  }
  return new TextEncoder().encode(secret);
}

export interface IssueTokenInput {
  accountId: string;
  companyId: string;
  normalizedEmail: string;
}

export async function issueMailSessionToken(
  input: IssueTokenInput,
): Promise<{ token: string; expiresAt: number }> {
  if (!UUID_RE.test(input.accountId)) throw new Error("accountId must be a UUID");
  if (!UUID_RE.test(input.companyId)) throw new Error("companyId must be a UUID");
  if (!input.normalizedEmail || !input.normalizedEmail.includes("@")) {
    throw new Error("normalizedEmail invalid");
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TTL_SECONDS;
  const jti = crypto.randomUUID();

  const token = await new SignJWT({
    ver: VER,
    cid: input.companyId,
    em: input.normalizedEmail,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(input.accountId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(getSecretKey());

  return { token, expiresAt: exp };
}

export async function verifyMailSessionToken(token: string): Promise<MailSessionClaims> {
  const { payload, protectedHeader } = await jwtVerify(token, getSecretKey(), {
    issuer: ISS,
    audience: AUD,
    algorithms: ["HS256"],
  });

  if (protectedHeader.alg !== "HS256") throw new Error("Invalid algorithm");
  if (payload.ver !== VER) throw new Error("Invalid token version");

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const cid = typeof payload.cid === "string" ? payload.cid : "";
  const em = typeof payload.em === "string" ? payload.em : "";
  if (!UUID_RE.test(sub)) throw new Error("Invalid sub");
  if (!UUID_RE.test(cid)) throw new Error("Invalid cid");
  if (!em || !em.includes("@") || em !== em.toLowerCase().trim()) {
    throw new Error("Invalid em");
  }

  return payload as unknown as MailSessionClaims;
}

export const __test__ = { ISS, AUD, VER, TTL_SECONDS };
