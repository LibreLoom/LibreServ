import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "./button.jsx";
import { cn } from "../../lib/utils.js";

/**
 * Dialog — an accessible modal surface in the Simplex Mono design language.
 *
 * Renders nothing while `open` is false. Closes on Escape or on a backdrop
 * click. The panel carries its own contrast (`bg-card text-card-foreground`),
 * and actions use the standard pill Button variants — `danger` turns the
 * confirm action destructive for irreversible changes.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onOpenChange
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {import("react").ReactNode} [props.children] - extra body content
 * @param {string} [props.confirmLabel]  default "Confirm"
 * @param {string} [props.cancelLabel]   default "Cancel"
 * @param {() => void} [props.onConfirm] - runs when the confirm button is clicked
 * @param {() => void} [props.onCancel]  - runs when cancelled; defaults to closing
 * @param {boolean} [props.danger]       - destructive styling for the confirm button
 * @param {boolean} [props.loading]      - disables both buttons, shows spinner on confirm
 * @param {string} [props.className]
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  danger = false,
  loading = false,
  className = "",
}) {
  const panelRef = useRef(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the panel so screen readers announce it.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <div
        className="absolute inset-0 bg-black/60 animate-fade-in"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "relative w-full max-w-md rounded-large-element border border-border bg-card text-card-foreground p-6 shadow-[0_8px_32px_rgba(0,0,0,0.35)] outline-none animate-pop-in",
          className
        )}
      >
        <div className="flex items-start justify-between gap-4 mb-3">
          <h2 id={titleId} className="font-mono text-lg leading-none tracking-tight">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            disabled={loading}
            aria-label="Close"
            className="h-8 w-8 shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {description && (
          <p id={descId} className="text-sm text-muted-foreground leading-relaxed">
            {description}
          </p>
        )}
        {children}
        <div className="flex justify-end gap-3 mt-6">
          <Button
            variant="outline"
            onClick={onCancel || (() => onOpenChange(false))}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "destructive" : "default"}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
