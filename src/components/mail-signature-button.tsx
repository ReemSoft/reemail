/**
 * "Insert signature" control for the composer footer.
 *
 * Zero cost until used: the stored signature is fetched only on the first
 * click (and cached for the tab session afterwards). Nothing runs on app
 * start, on opening a message, or on opening the composer.
 */
import { useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Image,
  Link,
  Loader2,
  PenLine,
  Pencil,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";

export function MailSignatureButton({
  disabled,
  mailSessionToken,
  onInsert,
}: {
  disabled?: boolean;
  mailSessionToken: string;
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
      const html = await loadSignature(mailSessionToken);
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
      setDraft(await loadSignature(mailSessionToken));
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
      const clean = await saveSignature(mailSessionToken, html);
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
        mailSessionToken={mailSessionToken}
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
  mailSessionToken,
  saving,
  onCancel,
  onSave,
}: {
  open: boolean;
  initialHtml: string;
  mailSessionToken: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (html: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<Range | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  useEffect(() => {
    if (!open || !editorRef.current) return;
    editorRef.current.innerHTML = initialHtml;
    selectionRef.current = null;
  }, [initialHtml, open]);

  function rememberSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editorRef.current) return;
    const range = selection.getRangeAt(0);
    if (editorRef.current.contains(range.commonAncestorContainer)) {
      selectionRef.current = range.cloneRange();
    }
  }

  function restoreSelection() {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const range = selectionRef.current;
    if (!range) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function exec(command: string) {
    restoreSelection();
    document.execCommand(command);
    rememberSelection();
  }

  function safeHttpsUrl(value: string): string | null {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function insertLink() {
    rememberSelection();
    const value = window.prompt(tr("رابط URL (يبدأ بـ https://):"), "https://");
    if (!value) return;
    const url = safeHttpsUrl(value);
    if (!url) {
      toast.error(tr("رابط غير صالح"));
      return;
    }
    restoreSelection();
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      document.execCommand("createLink", false, url);
    } else {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = url;
      document.execCommand("insertHTML", false, anchor.outerHTML);
    }
    rememberSelection();
  }

  function chooseImage() {
    rememberSelection();
    imageInputRef.current?.click();
  }

  async function insertImage(file: File | undefined) {
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
      toast.error(tr("نوع الصورة غير مدعوم"));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error(tr("حجم الصورة كبير جداً (الحد 2MB)"));
      return;
    }
    setUploadingImage(true);
    let url: string;
    try {
      const response = await fetch("/api/mail-signature-image", {
        method: "POST",
        headers: { "Content-Type": file.type, "x-mail-session-token": mailSessionToken },
        body: file,
      });
      const result = (await response.json()) as { ok?: boolean; url?: string };
      if (!response.ok || !result.ok || !result.url) throw new Error("UPLOAD_FAILED");
      url = result.url;
    } catch {
      toast.error(tr("تعذّر إدراج صورة التوقيع"));
      setUploadingImage(false);
      return;
    }
    restoreSelection();
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.style.maxWidth = "100%";
    image.style.height = "auto";
    const wrapper = document.createElement("div");
    wrapper.appendChild(image);
    document.execCommand("insertHTML", false, wrapper.outerHTML);
    rememberSelection();
    setUploadingImage(false);
  }

  const tools = [
    { command: "bold", label: "B", className: "font-bold", title: tr("عريض (Ctrl+B)") },
    { command: "italic", label: "I", className: "italic", title: "Italic" },
    { command: "underline", label: "U", className: "underline", title: "Underline" },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle className="text-base">{tr("توقيع البريد")}</DialogTitle>
          <DialogDescription className="text-sm">
            {tr("اكتب توقيعك هنا. سيُدرج في نهاية رسالتك عند الضغط على إدخال التوقيع.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1 border-b border-border/70 pb-2">
          {tools.map((tool) => (
            <Button
              key={tool.command}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                exec(tool.command);
              }}
              variant="ghost"
              size="icon"
              className={`h-8 w-8 text-xs ${tool.className}`}
              title={tool.title}
              aria-label={tool.title}
            >
              {tool.label}
            </Button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onMouseDown={(e) => { e.preventDefault(); insertLink(); }} title={tr("إدراج رابط")} aria-label={tr("إدراج رابط")}><Link /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={uploadingImage} onMouseDown={(e) => { e.preventDefault(); chooseImage(); }} title={tr("إدراج صورة")} aria-label={tr("إدراج صورة")}>{uploadingImage ? <Loader2 className="animate-spin" /> : <Image />}</Button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onMouseDown={(e) => { e.preventDefault(); exec("justifyLeft"); }} title={tr("محاذاة لليسار")} aria-label={tr("محاذاة لليسار")}><AlignLeft /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onMouseDown={(e) => { e.preventDefault(); exec("justifyCenter"); }} title={tr("توسيط")} aria-label={tr("توسيط")}><AlignCenter /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onMouseDown={(e) => { e.preventDefault(); exec("justifyRight"); }} title={tr("محاذاة لليمين")} aria-label={tr("محاذاة لليمين")}><AlignRight /></Button>
        </div>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(event) => void insertImage(event.target.files?.[0])}
        />
        <div
          ref={(el) => {
            editorRef.current = el;
          }}
          contentEditable
          dir="auto"
          suppressContentEditableWarning
          onInput={rememberSelection}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
          className="composer-editor min-h-[140px] w-full overflow-auto rounded-lg border border-input bg-background p-3 text-sm outline-none focus:border-primary"
        />
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-start">
          <Button
            type="button"
            onClick={() => onSave(editorRef.current?.innerHTML ?? "")}
            disabled={saving}
            size="sm"
            className="bg-brand-gradient shadow-brand hover:opacity-95"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {tr("حفظ التوقيع")}
          </Button>
          <Button
            type="button"
            onClick={onCancel}
            variant="outline"
            size="sm"
          >
            {tr("إلغاء")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
