// Phase B — Mailbox switcher (multi-mailbox, up to 5 linked mailboxes).
//
// The password of every mailbox lives ONLY in this tab's sessionStorage
// (mailbox pool). Switching to a mailbox whose password is not in the pool
// asks for it and re-verifies it against the real IMAP server.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, ChevronDown, Loader2, Mail, Plus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { tr } from "@/i18n";
import { useLanguage } from "@/hooks/use-language";
import {
  listLinkedMailboxes,
  linkMailbox,
  switchMailbox,
  unlinkMailbox,
  type LinkedMailboxSummary,
} from "@/lib/mail-linked-mailboxes.functions";
import {
  listPooledMailboxes,
  removePooledMailbox,
  setActiveMailbox,
  type MailSession,
} from "@/lib/mail-session";

interface Props {
  session: MailSession;
}

export function MailboxSwitcher({ session }: Props) {
  const { dir } = useLanguage();
  const listFn = useServerFn(listLinkedMailboxes);
  const linkFn = useServerFn(linkMailbox);
  const switchFn = useServerFn(switchMailbox);
  const unlinkFn = useServerFn(unlinkMailbox);

  const [linked, setLinked] = useState<LinkedMailboxSummary[]>([]);
  const [max, setMax] = useState(5);
  const [busy, setBusy] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");

  const [askFor, setAskFor] = useState<LinkedMailboxSummary | null>(null);
  const [askPassword, setAskPassword] = useState("");

  const token = session.mailSessionToken ?? "";

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const res = await listFn({ data: { mailSessionToken: token } });
      if (res.ok) {
        setLinked(res.mailboxes);
        setMax(res.max);
      }
    } catch {
      /* silent — switcher is non-critical */
    }
  }, [listFn, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function activate(next: MailSession) {
    setActiveMailbox(next);
    // Full reload guarantees every cache (index sync, origins, message cache)
    // is rebuilt for the new mailbox instead of mixing two identities.
    window.location.reload();
  }

  async function doSwitch(target: LinkedMailboxSummary, password?: string) {
    setBusy(true);
    try {
      const pooled = listPooledMailboxes().find((m) => m.account.id === target.accountId);
      const pwd = password ?? pooled?.password;
      if (!pwd) {
        setAskFor(target);
        setAskPassword("");
        return;
      }
      const res = await switchFn({
        data: { mailSessionToken: token, targetAccountId: target.accountId, password: pwd },
      });
      if (!res.ok) {
        toast.error(tr(res.message));
        return;
      }
      activate({
        account: res.mailbox.account,
        company: res.mailbox.company,
        password: pwd,
        mailSessionToken: res.mailbox.mailSessionToken,
        mailSessionTokenExpiresAt: res.mailbox.mailSessionTokenExpiresAt,
      });
    } catch {
      toast.error(tr("تعذر تبديل صندوق البريد."));
    } finally {
      setBusy(false);
    }
  }

  async function doAdd() {
    if (!addEmail.includes("@") || addPassword.length < 1) {
      toast.error(tr("أدخل البريد وكلمة المرور."));
      return;
    }
    setBusy(true);
    try {
      const res = await linkFn({
        data: {
          mailSessionToken: token,
          email: addEmail.trim().toLowerCase(),
          password: addPassword,
          ...(advanced && imapHost
            ? {
                imapHost: imapHost.trim(),
                imapPort: Number(imapPort) || 993,
                imapSecure: true,
                smtpHost: smtpHost.trim() || imapHost.trim(),
                smtpPort: Number(smtpPort) || 465,
                smtpSecure: true,
              }
            : {}),
        },
      });
      if (!res.ok) {
        toast.error(tr(res.message));
        return;
      }
      toast.success(tr("تم ربط صندوق البريد."));
      setAddOpen(false);
      setAddEmail("");
      setAddPassword("");
      activate({
        account: res.mailbox.account,
        company: res.mailbox.company,
        password: addPassword,
        mailSessionToken: res.mailbox.mailSessionToken,
        mailSessionTokenExpiresAt: res.mailbox.mailSessionTokenExpiresAt,
      });
    } catch {
      toast.error(tr("تعذر ربط صندوق البريد."));
    } finally {
      setBusy(false);
    }
  }

  async function doUnlink(target: LinkedMailboxSummary) {
    setBusy(true);
    try {
      const res = await unlinkFn({
        data: { mailSessionToken: token, linkedAccountId: target.accountId },
      });
      if (!res.ok) {
        toast.error(tr(res.message ?? "تعذر إلغاء الربط."));
        return;
      }
      removePooledMailbox(target.accountId);
      setLinked((prev) => prev.filter((m) => m.accountId !== target.accountId));
      toast.success(tr("تم إلغاء الربط."));
    } finally {
      setBusy(false);
    }
  }

  const atCap = linked.length >= max;

  return (
    <>
      <DropdownMenu dir={dir}>
        <DropdownMenuTrigger asChild>
          <button
            className="flex max-w-[220px] items-center gap-1.5 rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted"
            title={session.account.email_address}
          >
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate" dir="ltr">
              {session.account.email_address}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>{tr("صناديق البريد")}</DropdownMenuLabel>
          <DropdownMenuItem className="cursor-default gap-2" onSelect={(e) => e.preventDefault()}>
            <Check className="h-4 w-4 text-primary" />
            <span className="truncate text-xs" dir="ltr">
              {session.account.email_address}
            </span>
          </DropdownMenuItem>
          {linked
            .filter((m) => m.accountId !== session.account.id)
            .map((m) => (
              <DropdownMenuItem
                key={m.accountId}
                className="group cursor-pointer gap-2"
                onSelect={(e) => {
                  e.preventDefault();
                  void doSwitch(m);
                }}
              >
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate text-xs" dir="ltr">
                  {m.emailAddress}
                </span>
                <button
                  aria-label={tr("إلغاء الربط")}
                  className="opacity-0 transition group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    void doUnlink(m);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </button>
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={atCap || busy}
            className="cursor-pointer gap-2"
            onSelect={(e) => {
              e.preventDefault();
              if (!atCap) setAddOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            <span className="text-xs">
              {atCap ? tr("بلغت الحد الأقصى للصناديق المرتبطة") : tr("إضافة صندوق بريد")}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tr("إضافة صندوق بريد")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mb-email">{tr("البريد الإلكتروني")}</Label>
              <Input
                id="mb-email"
                dir="ltr"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mb-pass">{tr("كلمة المرور")}</Label>
              <Input
                id="mb-pass"
                type="password"
                dir="ltr"
                value={addPassword}
                onChange={(e) => setAddPassword(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="text-xs text-primary underline underline-offset-2"
              onClick={() => setAdvanced((v) => !v)}
            >
              {advanced ? tr("إخفاء الإعدادات المتقدمة") : tr("إعدادات الاتصال المتقدمة")}
            </button>
            {advanced && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mb-imap">IMAP</Label>
                  <Input
                    id="mb-imap"
                    dir="ltr"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    placeholder="imap.example.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mb-imap-port">IMAP Port</Label>
                  <Input
                    id="mb-imap-port"
                    dir="ltr"
                    value={imapPort}
                    onChange={(e) => setImapPort(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mb-smtp">SMTP</Label>
                  <Input
                    id="mb-smtp"
                    dir="ltr"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mb-smtp-port">SMTP Port</Label>
                  <Input
                    id="mb-smtp-port"
                    dir="ltr"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                  />
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {tr("تبقى كلمة المرور داخل جلسة المتصفح فقط ويتم التحقق منها مباشرة من خادم البريد.")}
            </p>
            <Button className="w-full" disabled={busy} onClick={() => void doAdd()}>
              {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {tr("ربط وتفعيل")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={askFor !== null} onOpenChange={(o) => !o && setAskFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{tr("كلمة المرور مطلوبة")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground" dir="ltr">
              {askFor?.emailAddress}
            </p>
            <Input
              type="password"
              dir="ltr"
              value={askPassword}
              onChange={(e) => setAskPassword(e.target.value)}
            />
            <Button
              className="w-full"
              disabled={busy || askPassword.length < 1}
              onClick={() => {
                const target = askFor;
                setAskFor(null);
                if (target) void doSwitch(target, askPassword);
              }}
            >
              {tr("تبديل")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
