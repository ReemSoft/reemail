// Demo-only replica of <MailboxSwitcher /> — identical layout/order/direction,
// backed by mock mailboxes (no server calls, no credentials).
import { useState } from "react";
import { Check, ChevronDown, Mail, Plus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { tr } from "@/i18n";
import { useLanguage } from "@/hooks/use-language";

const DEMO_MAILBOXES = [
  "demo@mailmaestro.online",
  "sales@mailmaestro.online",
  "support@mailmaestro.online",
  "billing@mailmaestro.online",
  "info@mailmaestro.online",
];

const MAX = 5;

interface Props {
  /** Icon-only trigger (mobile top bar). */
  compact?: boolean;
}

export function DemoMailboxSwitcher({ compact = false }: Props) {
  const { dir } = useLanguage();
  const [active, setActive] = useState(DEMO_MAILBOXES[0]);

  const addrAlign = dir === "rtl" ? "text-end" : "text-start";
  const atCap = DEMO_MAILBOXES.length >= MAX;

  return (
    <DropdownMenu dir={dir}>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted"
            title={active}
            aria-label={tr("صناديق البريد")}
          >
            <Mail className="h-4 w-4" />
          </button>
        ) : (
          <button
            className="flex max-w-[220px] items-center gap-1.5 rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted"
            title={active}
          >
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <span className={`truncate ${addrAlign}`} dir="ltr">
              {active}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-1.5">
        <DropdownMenuLabel className="px-2 pb-1.5 text-start text-xs text-muted-foreground">
          {tr("صناديق البريد")}
        </DropdownMenuLabel>
        <DropdownMenuItem
          className="mx-1 my-0.5 flex cursor-default items-center gap-2 rounded-md bg-accent/50 px-2 py-1.5"
          onSelect={(e) => e.preventDefault()}
        >
          <Mail className="h-4 w-4 shrink-0 text-primary" />
          <span className={`min-w-0 flex-1 truncate text-xs ${addrAlign}`} dir="ltr">
            {active}
          </span>
          <Check className="h-4 w-4 shrink-0 text-primary" />
        </DropdownMenuItem>
        {DEMO_MAILBOXES.filter((m) => m !== active).map((m) => (
          <DropdownMenuItem
            key={m}
            className="group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent focus:bg-accent"
            onSelect={(e) => {
              e.preventDefault();
              setActive(m);
            }}
          >
            <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={`min-w-0 flex-1 truncate text-xs ${addrAlign}`} dir="ltr">
              {m}
            </span>
            <button
              type="button"
              aria-label={tr("إلغاء الربط")}
              className="shrink-0 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </button>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="mx-1 my-1" />
        <DropdownMenuItem
          disabled={atCap}
          className="mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent focus:bg-accent"
          onSelect={(e) => e.preventDefault()}
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-start text-xs">
            {atCap ? tr("بلغت الحد الأقصى للصناديق المرتبطة") : tr("إضافة صندوق بريد")}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
