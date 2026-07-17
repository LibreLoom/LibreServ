import { cn } from "@/lib/utils";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import Card from "./Card";
import Button from "../ui/Button";

/**
 * VerificationCard - Modal card for confirming destructive actions like user deletion
 */
export default function VerificationCard({
  title = "Confirm Action",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  variant = "danger", // "danger" or "warning"
}) {
  const [isClosing, setIsClosing] = useState(false);
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  const onConfirmRef = useRef(onConfirm);
  const isClosingRef = useRef(false);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    setTimeout(() => {
      onCancelRef.current?.();
    }, 300);
  }, []);

  const handleConfirm = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    setTimeout(() => {
      onConfirmRef.current?.();
    }, 300);
  }, []);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }

      if (event.key === "Tab") {
        const focusableElements = dialogRef.current?.querySelectorAll(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusableElements || focusableElements.length === 0) return;
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [handleClose]);

  return (
    <div className={cn(
      "fixed inset-0 bg-primary/60 backdrop-blur-sm flex items-center justify-center z-50 p-4",
      isClosing ? "animate-out fade-out zoom-out-95" : "animate-in fade-in zoom-in-95"
    )} data-slot="verification-card">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="max-w-md w-full"
      >
        <Card className={cn("relative", isClosing && "pop-out")}>
          {/* Close button */}
          <Button
            variant="ghost"
            size="icon"
            surface="secondary"
            onClick={handleClose}
            className="absolute top-5 right-5"
            aria-label="Close"
            ref={closeButtonRef}
          >
            <X size={20} aria-hidden="true" />
          </Button>

          {/* Warning icon and title */}
          <div className="flex items-center gap-4 mb-4">
            <div className="h-12 w-12 rounded-pill bg-primary text-secondary flex items-center justify-center">
              <AlertTriangle size={24} aria-hidden="true" />
            </div>
            <h2 id={titleId} className="text-xl font-mono font-normal">
              {title}
            </h2>
          </div>

          {/* Divider */}
          <div
            className="h-1 bg-primary rounded-pill mx-1 my-4"
            aria-hidden="true"
          />

          {/* Message */}
          <div className="mb-6 text-left">
            <p id={messageId} className="text-sm text-primary/80">
              {message}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <Button
              variant="outline"
              surface="secondary"
              onClick={handleClose}
              className="flex-1"
            >
              {cancelLabel}
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              onClick={handleConfirm}
              className="flex-1"
            >
              {confirmLabel}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
