import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
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

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onCancel();
    }, 300); // Match animation duration
  };

  const handleConfirm = () => {
    setIsClosing(true);
    setTimeout(() => {
      onConfirm();
    }, 300); // Match animation duration
  };

  return (
    <div className="fixed inset-0 bg-primary flex items-center justify-center z-50 p-4">
      <Card
        className={`max-w-md w-full relative ${isClosing ? "pop-out" : ""}`}
      >
        {/* Close button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 text-accent mode-safe:transition hover:bg-secondary hover:text-primary"
          aria-label="Close"
        >
          <X size={24} />
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
          <h2 className="text-xl font-bold">{title}</h2>
        </div>

        {/* Divider */}
        <div className="h-1 bg-primary rounded-pill mx-1 my-4" />

        {/* Message */}
        <div className="mb-6 text-left">
          <p className="text-sm">{message}</p>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2 bg-primary text-secondary rounded-pill motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid font-medium"
          >
            {cancelLabel}
          </button>
          <button
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
  );
}
