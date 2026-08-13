import type { MailAddress, MailMessage } from "@/lib/mail-types";
import {
  MAX_PERSISTED_THREAD_REFERENCES,
  normalizePersistedThreadIdentity,
} from "@/lib/mail-rfc-message-id";

export const MAX_THREAD_REFERENCES = MAX_PERSISTED_THREAD_REFERENCES;

function cleanAddress(address: MailAddress): MailAddress | null {
  const email = address.email.trim();
  if (!email || /[\r\n]/.test(email) || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const name = address.name.replace(/[\r\n]+/g, " ").trim();
  return { name, email };
}

function addressKey(address: MailAddress): string {
  return address.email.trim().toLowerCase();
}

export function formatComposeAddress(address: MailAddress): string {
  const clean = cleanAddress(address);
  if (!clean) return "";
  return clean.name ? `${clean.name} <${clean.email}>` : clean.email;
}

export const normalizeRfcMessageId = normalizePersistedThreadIdentity;

export function buildThreadingHeaders(
  references: readonly string[] | undefined,
  parentCandidate: unknown,
): { inReplyTo?: string; references?: string[] } {
  const parent = normalizeRfcMessageId(parentCandidate);
  if (!parent) return {};
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const candidate of references ?? []) {
    const normalized = normalizeRfcMessageId(candidate);
    if (!normalized || normalized === parent || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  ordered.push(parent);
  const bounded =
    ordered.length <= MAX_THREAD_REFERENCES
      ? ordered
      : [ordered[0], ...ordered.slice(-(MAX_THREAD_REFERENCES - 1))];
  return { inReplyTo: parent, references: bounded };
}

export function buildReplyRecipients(
  message: Pick<MailMessage, "from" | "replyTo" | "to" | "cc">,
  myEmail: string,
  replyAll: boolean,
): { to: MailAddress[]; cc: MailAddress[] } {
  const self = myEmail.trim().toLowerCase();
  const validReplyTo = (message.replyTo ?? []).flatMap((candidate) => {
    const clean = cleanAddress(candidate);
    return clean ? [clean] : [];
  });
  const primaryCandidates = validReplyTo.length ? validReplyTo : [message.from];
  const to: MailAddress[] = [];
  const cc: MailAddress[] = [];
  const seen = new Set<string>();
  const append = (target: MailAddress[], candidate: MailAddress) => {
    const clean = cleanAddress(candidate);
    if (!clean) return;
    const key = addressKey(clean);
    if (!key || key === self || seen.has(key)) return;
    seen.add(key);
    target.push(clean);
  };
  for (const candidate of primaryCandidates) append(to, candidate);
  if (replyAll) {
    for (const candidate of message.to) append(to, candidate);
    for (const candidate of message.cc ?? []) append(cc, candidate);
  }
  return { to, cc };
}
