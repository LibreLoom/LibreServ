import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import Card from "./Card";

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
    <div className="fixed inset-0 bg-primary flex items-center justify-center z-50 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="max-w-md w-full"
      >
        <Card className={`relative ${isClosing ? "pop-out" : ""}`}>
          {/* Close button */}
          <button
            type="button"
            onClick={handleClose}
            className="absolute top-4 right-4 text-accent motion-safe:transition hover:bg-secondary hover:text-primary"
            aria-label="Close"
            ref={closeButtonRef}
          >
            <X size={24} aria-hidden="true" />
          </button>

          {/* Warning icon and title */}
          <div className="flex items-center gap-4 mb-4">
            <div
              className={`h-12 w-12 rounded-pill ${
                variant === "danger" ? "bg-accent" : "bg-secondary"
              } text-primary flex items-center justify-center`}
            >
              <AlertTriangle size={24} aria-hidden="true" />
            </div>
            <h2 id={titleId} className="text-xl font-mono font-normal">
              {title}
            </h2>
          </div>

          {/* Divider */}
          <div className="h-1 bg-primary rounded-pill mx-1 my-4" />

          {/* Message */}
          <div className="mb-6 text-left">
            <p id={messageId} className="text-sm">
              {message}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 px-4 py-2 bg-primary text-secondary rounded-pill motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid font-medium"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className={`flex-1 px-4 py-2 rounded-pill text-primary font-medium motion-safe:transition-all hover:opacity-80 ${
                variant === "danger" ? "bg-accent" : "bg-secondary"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
