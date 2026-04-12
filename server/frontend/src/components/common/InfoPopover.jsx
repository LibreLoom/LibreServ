import { useState, useRef, useEffect, useId } from "react";
import { Info } from "lucide-react";
import PropTypes from "prop-types";
import { createPortal } from "react-dom";

function InfoPopover({ children }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const titleId = useId();

  useEffect(() => {
    if (!open || !buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const popoverWidth = 256;
    const padding = 8;

    let left = rect.left + rect.width / 2 - popoverWidth / 2;
    let top = rect.bottom + padding;

    left = Math.max(padding, Math.min(left, window.innerWidth - popoverWidth - padding));

    setPosition({ top, left });

    function handleClickOutside(e) {
      if (buttonRef.current && !buttonRef.current.contains(e.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(e) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="text-primary/40 hover:text-primary/60 transition-colors"
        aria-label="More info"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Info className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="fixed z-[100] w-64"
            style={{ top: position.top, left: position.left }}
          >
            <div className="bg-secondary border border-primary/20 rounded-[12px] p-3 shadow-xl text-sm text-primary/80">
              <span id={titleId} className="sr-only">
                Additional information
              </span>
              {children}
            </div>
            <div
              className="absolute -top-1 w-2 h-2 bg-secondary border-l border-t border-primary/20 rotate-45"
              style={{ left: "50%", transform: "translateX(-50%)" }}
              aria-hidden="true"
            />
          </div>,
          document.body
        )}
    </>
  );
}

InfoPopover.propTypes = {
  children: PropTypes.node.isRequired,
};

export default InfoPopover;
