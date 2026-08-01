import { tr } from "@/i18n";
import * as React from "react";
import { createContext, useContext, useState, useCallback } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmVariant = "default" | "destructive";

export interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (value: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm(): ConfirmContextValue {
  const value = useContext(ConfirmContext);
  if (!value) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return value;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setRequest({
        id: Date.now(),
        resolve,
        title: "تأكيد",
        description: tr("هل أنت متأكد؟"),
        confirmLabel: tr("تأكيد"),
        cancelLabel: tr("إلغاء"),
        variant: "default",
        ...options,
      });
    });
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // User closed the dialog by pressing Escape or clicking outside
      request?.resolve(false);
      setRequest(null);
    }
  };

  const handleConfirm = () => {
    request?.resolve(true);
    setRequest(null);
  };

  const handleCancel = () => {
    request?.resolve(false);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <AlertDialog open={!!request} onOpenChange={handleOpenChange}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader className="text-center sm:text-start">
            <AlertDialogTitle>{request?.title}</AlertDialogTitle>
            {request?.description ? (
              <AlertDialogDescription>{request.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-start gap-2">
            <AlertDialogAction
              onClick={handleConfirm}
              className={
                request?.variant === "destructive"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : ""
              }
            >
              {request?.confirmLabel}
            </AlertDialogAction>
            <AlertDialogCancel onClick={handleCancel}>
              {request?.cancelLabel}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
