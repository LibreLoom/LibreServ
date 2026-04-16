import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import PropTypes from "prop-types";
import Card from "../cards/Card";

export default function SetupWizard({
  steps,
  currentStepId,
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled = false,
  nextLoading = false,
  showBack = true,
  showNext = true,
  children,
  onClose,
}) {
  const [isClosing, setIsClosing] = useState(false);
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  const handleClose = useCallback(() => {
    if (isClosing || nextLoading) return;
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
    }, 200);
  }, [isClosing, nextLoading, onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        if (nextLoading) return;
        event.preventDefault();
        handleClose();
        return;
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
  }, [handleClose, nextLoading]);

  const currentIdx = steps?.findIndex((s) => s.id === currentStepId) ?? -1;

  return createPortal(
    <div
      className={`fixed inset-0 bg-primary/60 backdrop-blur-sm flex items-center justify-center z-50 p-0 sm:p-4 animate-in fade-in duration-200 ${
        isClosing ? "animate-out fade-out duration-150" : ""
      }`}
      onClick={handleClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full max-w-[80dvw] h-[85dvh] sm:max-h-[calc(95vh-4rem)] flex flex-col ${
          isClosing ? "animate-out fade-out scale-[0.97] duration-150" : "animate-in fade-in slide-in-from-bottom-4 duration-300"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <Card
          noHeightAnim
          noPopIn
          className="relative flex-1 flex flex-col min-h-0 h-full overflow-hidden"
        >
          {onClose && !nextLoading && (
            <button
              type="button"
              onClick={handleClose}
              className="absolute top-3 right-3 sm:top-5 sm:right-5 p-2 rounded-pill text-primary motion-safe:transition-all hover:bg-primary hover:text-secondary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 z-10"
              aria-label="Close"
              ref={closeButtonRef}
            >
              <X size={20} aria-hidden="true" />
            </button>
          )}

          {steps && steps.length > 0 && currentIdx >= 0 && (
            <div className="flex items-center gap-2 mb-6 px-1 pt-8 sm:pt-0">
              {steps.map((step, i) => (
                <div
                  key={step.id}
                  className={`rounded-full motion-safe:transition-all motion-safe:duration-300 ${
                    i === currentIdx
                      ? "w-5 h-2 bg-primary"
                      : i < currentIdx
                      ? "w-2 h-2 bg-primary/40"
                      : "w-2 h-2 bg-primary/15"
                  }`}
                  title={step.label}
                  aria-label={step.label}
                />
              ))}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-2 sm:px-6 py-2 sm:py-4">
            <div className="max-w-lg mx-auto">
              {children}
            </div>
          </div>

          {(showBack || showNext) && (
            <div className="mt-4 pt-4 border-t border-primary/10 px-2 sm:px-6 flex items-center justify-between gap-4 flex-shrink-0">
              {showBack ? (
                <button
                  type="button"
                  onClick={onBack}
                  className="rounded-pill border border-primary/20 bg-transparent text-primary px-5 py-2.5 font-mono text-sm motion-safe:transition-all motion-safe:duration-200 hover:bg-primary/8 disabled:opacity-30 disabled:pointer-events-none"
                >
                  Back
                </button>
              ) : (
                <span />
              )}

              {showNext && (
                <button
                  type="button"
                  onClick={onNext}
                  disabled={nextDisabled || nextLoading}
                  className="group inline-flex items-center gap-2 rounded-pill bg-primary text-secondary px-6 py-2.5 font-mono text-sm tracking-wide motion-safe:transition-all motion-safe:duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-30 disabled:pointer-events-none disabled:scale-100"
                >
                  {nextLoading ? (
                    <>
                      <span className="animate-spin w-4 h-4 flex items-center justify-center">
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      </span>
                      Loading...
                    </>
                  ) : (
                    <>
                      {nextLabel}
                      <span className="motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5">
                        &#x2192;
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>,
    document.body,
  );
}

SetupWizard.propTypes = {
  steps: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string,
    }),
  ),
  currentStepId: PropTypes.string.isRequired,
  onBack: PropTypes.func,
  onNext: PropTypes.func,
  nextLabel: PropTypes.string,
  nextDisabled: PropTypes.bool,
  nextLoading: PropTypes.bool,
  showBack: PropTypes.bool,
  showNext: PropTypes.bool,
  children: PropTypes.node.isRequired,
  onClose: PropTypes.func,
};
