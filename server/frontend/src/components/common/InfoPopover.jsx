import { useState, useRef, useEffect } from "react";
import { Info } from "lucide-react";
import PropTypes from "prop-types";
import { createPortal } from "react-dom";

function InfoPopover({ children }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const popoverWidth = 256; // w-64 = 16rem = 256px
    const padding = 8;

    // Center below the button
    let left = rect.left + rect.width / 2 - popoverWidth / 2;
    let top = rect.bottom + padding;

    // Keep within viewport
    left = Math.max(padding, Math.min(left, window.innerWidth - popoverWidth - padding));

    setPosition({ top, left });

    function handleClickOutside(e) {
      if (buttonRef.current && !buttonRef.current.contains(e.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="text-primary/40 hover:text-primary/60 transition-colors"
        aria-label="More info"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open &&
        createPortal(
          <div
            className="fixed z-[100] w-64"
            style={{ top: position.top, left: position.left }}
          >
            <div className="bg-secondary border border-primary/20 rounded-[12px] p-3 shadow-xl text-sm text-primary/80">
              {children}
            </div>
            <div
              className="absolute -top-1 w-2 h-2 bg-secondary border-l border-t border-primary/20 rotate-45"
              style={{ left: "50%", transform: "translateX(-50%)" }}
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
