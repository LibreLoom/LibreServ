import { useCallback, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import Card from "../common/cards/Card";

export default function ModalCard({
  title,
  children,
  onClose,
  showCloseButton = true,
  size = "md",
}) {
  const [isClosing, setIsClosing] = useState(false);
  const [isEntering, setIsEntering] = useState(true);
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
    }, 300);
  }, [isClosing, onClose]);

  useEffect(() => {
    const timer = setTimeout(() => setIsEntering(false), 200);
    return () => clearTimeout(timer);
  }, []);

  const content = typeof children === "function" ? children({ close: handleClose }) : children;

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
    <div
      className={`fixed inset-0 bg-primary/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 ${isClosing ? "pop-out" : isEntering ? "pop-in" : ""}`}
      onClick={handleClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full transition-all flex flex-col mb-16 ${size === "fullscreen" ? "max-w-[95vw] max-h-[calc(95vh-4rem)]" : size === "lg" ? "max-w-3xl max-h-[calc(95vh-4rem)]" : size === "xl" ? "max-w-5xl max-h-[calc(95vh-4rem)]" : "max-w-md max-h-[calc(95vh-4rem)]"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <Card className={`relative flex-1 flex flex-col min-h-0 overflow-y-auto ${isClosing ? "pop-out" : isEntering ? "pop-in" : ""}`}>
          {showCloseButton && (
            <button
              type="button"
              onClick={handleClose}
              className="absolute top-5 right-5 p-2 rounded-pill text-primary motion-safe:transition-all hover:bg-primary hover:text-secondary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              aria-label="Close"
              ref={closeButtonRef}
            >
              <X size={20} aria-hidden="true" />
            </button>
          )}

          {title && (
            <h2 id={titleId} className="text-xl font-mono font-normal mb-4 pr-10">
              {title}
            </h2>
          )}

          {content}
        </Card>
      </div>
    </div>
  );
}
