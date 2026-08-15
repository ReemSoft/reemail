/**
 * "Insert signature" control for the composer footer.
 *
 * Zero cost until used: the stored signature is fetched only on the first
 * click (and cached for the tab session afterwards). Nothing runs on app
 * start, on opening a message, or on opening the composer.
 */
import { useState } from "react";
import { PenLine, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { tr } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isSignatureEmpty } from "@/lib/mail-signature";
import { loadSignature, saveSignature } from "@/lib/mail-signature.browser";

export function MailSignatureButton({
  disabled,
  onInsert,
}: {
  disabled?: boolean;
  onInsert: (html: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleInsert() {
    if (busy) return;
    setBusy(true);
    try {
      const html = await loadSignature();
      if (isSignatureEmpty(html)) {
        setDraft(html);
        setEditorOpen(true);
        return;
      }
      onInsert(html);
    } catch {
      toast.error(tr("تعذّر تحميل التوقيع"));
    } finally {
      setBusy(false);
    }
  }

  async function handleEdit() {
    setBusy(true);
    try {
      setDraft(await loadSignature());
      setEditorOpen(true);
    } catch {
      toast.error(tr("تعذّر تحميل التوقيع"));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(html: string) {
    setSaving(true);
    try {
      const clean = await saveSignature(html);
      setEditorOpen(false);
      toast.success(tr("تم حفظ التوقيع"));
      if (!isSignatureEmpty(clean)) onInsert(clean);
    } catch {
      toast.error(tr("تعذّر حفظ التوقيع"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled || busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40 sm:px-3"
            aria-label={tr("إدخال التوقيع")}
            title={tr("إدخال التوقيع")}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PenLine className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">{tr("إدخال التوقيع")}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[190px]">
          <DropdownMenuItem onSelect={() => void handleInsert()} className="gap-2 text-xs">
            <PenLine className="h-3.5 w-3.5" />
            {tr("إدخال التوقيع")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleEdit()} className="gap-2 text-xs">
            <Pencil className="h-3.5 w-3.5" />
            {tr("تعديل التوقيع")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SignatureEditorDialog
        open={editorOpen}
        initialHtml={draft}
        saving={saving}
        onCancel={() => setEditorOpen(false)}
        onSave={(html) => void handleSave(html)}
      />
    </>
  );
}

function SignatureEditorDialog({
  open,
  initialHtml,
  saving,
  onCancel,
  onSave,
}: {
  open: boolean;
  initialHtml: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (html: string) => void;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle className="text-base">{tr("توقيع البريد")}</DialogTitle>
          <DialogDescription className="text-sm">
            {tr("اكتب توقيعك هنا. سيُدرج في نهاية رسالتك عند الضغط على إدخال التوقيع.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1 border-b border-border/70 pb-2">
          {(
            [
              ["bold", "B", "font-bold"],
              ["italic", "I", "italic"],
              ["underline", "U", "underline"],
            ] as const
          ).map(([cmd, label, cls]) => (
            <button
              key={cmd}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                document.execCommand(cmd);
              }}
              className={`h-7 w-7 rounded-md text-xs transition hover:bg-muted ${cls}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          key={open ? "open" : "closed"}
          ref={(el) => {
            setNode(el);
            if (el && el.innerHTML === "") el.innerHTML = initialHtml;
          }}
          contentEditable
          dir="auto"
          suppressContentEditableWarning
          className="composer-editor min-h-[140px] w-full overflow-auto rounded-lg border border-input bg-background p-3 text-sm outline-none focus:border-primary"
        />
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-start">
          <button
            type="button"
            onClick={() => onSave(node?.innerHTML ?? "")}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white shadow-brand transition hover:opacity-95 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {tr("حفظ التوقيع")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-input bg-background px-3 py-2 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground"
          >
            {tr("إلغاء")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
