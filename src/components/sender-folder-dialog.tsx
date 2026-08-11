// Create / edit / delete a "sender folder" — a virtual filter folder that
// shows every Inbox message coming from one address. Purely a saved filter:
// it never moves, copies, or deletes any message.
import { useEffect, useState } from "react";
import { Folder, Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SENDER_FOLDER_COLORS, senderFolderColor } from "@/lib/mail-sender-folder-colors";
import { tr } from "@/i18n";

export interface SenderFolderDraft {
  email: string;
  name: string;
  color: string;
}

export function SenderFolderDialog({
  open,
  onOpenChange,
  email,
  initialName,
  initialColor,
  existing,
  busy,
  onSave,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  email: string;
  initialName: string;
  initialColor: string;
  existing: boolean;
  busy: boolean;
  onSave: (draft: SenderFolderDraft) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setColor(initialColor);
    }
  }, [open, initialName, initialColor]);

  const active = senderFolderColor(color);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-start">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ backgroundColor: active.soft }}
            >
              <Folder className="h-4 w-4" style={{ color: active.hex }} />
            </span>
            {existing ? tr("تعديل المجلد الخاص") : tr("إنشاء مجلد خاص")}
          </DialogTitle>
          <DialogDescription className="text-start">
            {tr("مجلد فلترة يعرض رسائل هذا المرسل فقط، بدون أي تغيير على صندوق الوارد.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {tr("بريد المرسل")}
            </label>
            <div
              dir="ltr"
              className="truncate rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
            >
              {email}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="sender-folder-name" className="text-xs font-medium text-muted-foreground">
              {tr("اسم المجلد")}
            </label>
            <input
              id="sender-folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">{tr("لون المجلد")}</span>
            <div className="flex flex-wrap gap-2">
              {SENDER_FOLDER_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setColor(c.key)}
                  aria-label={c.key}
                  aria-pressed={color === c.key}
                  className={`h-8 w-8 rounded-full border-2 transition ${
                    color === c.key ? "border-foreground/50 scale-110" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {existing ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {tr("حذف المجلد")}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-muted"
            >
              {tr("إلغاء")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onSave({ email, name: name.trim() || email, color })}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-4 py-2 text-xs font-semibold text-white shadow-brand transition hover:scale-[1.02] disabled:opacity-60"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {existing ? tr("حفظ التعديلات") : tr("إنشاء مجلد")}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
