import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { ChevronDown, HardDrive } from "lucide-react";
import Button from "../ui/Button.jsx";
import { cn } from "@/lib/utils";
import { haptic } from "../../utils/haptics.js";

/**
 * Dropdown menu for Copy and Move actions in file browser.
 *
 * When only 1 drive is available, renders as a single button.
 * When multiple drives are available (accounting for 10+ drives),
 * clicking the trigger opens a scrollable, bounded dropdown list
 * allowing the user to copy/move within this drive or to any other drive.
 */
export default function TransferMenu({
  label,
  icon: Icon,
  drives = [],
  currentDriveId,
  currentDriveLabel = "Drive",
  onPick,
  disabled = false,
}) {
  const activeDrives = useMemo(() => {
    return drives.filter((d) => (
      d.state !== "missing"
      && d.state !== "ejected"
      && d.state !== "failed"
      && d.state !== "readonly"
    ));
  }, [drives]);

  const otherDrives = useMemo(() => {
    return activeDrives.filter((d) => d.id !== currentDriveId);
  }, [activeDrives, currentDriveId]);

  const hasOtherDrives = otherDrives.length > 0;

  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const portalRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  const options = useMemo(() => {
    const list = [
      {
        id: currentDriveId,
        label: `${label} within ${currentDriveLabel}...`,
        isCurrent: true,
      },
    ];
    for (const d of otherDrives) {
      list.push({
        id: d.id,
        label: `${label} to ${d.label}...`,
        isCurrent: false,
      });
    }
    return list;
  }, [label, currentDriveId, currentDriveLabel, otherDrives]);

  const close = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      setActiveIndex(0);
    }, 160);
  }, []);

  const updatePosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const menuWidth = portalRef.current?.offsetWidth || Math.max(rect.width, 200);
    let left = rect.left + window.scrollX;
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8;
    }
    if (left < 8) left = 8;
    setPosition({ top: rect.bottom + window.scrollY + 4, left });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    function handleClickOutside(event) {
      if (
        containerRef.current?.contains(event.target) ||
        portalRef.current?.contains(event.target)
      ) {
        return;
      }
      close();
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        containerRef.current?.querySelector("button")?.focus();
      }
    }
    function handleScrollOrResize() {
      updatePosition();
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen, close, updatePosition]);

  useLayoutEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, updatePosition]);

  function handleTriggerClick() {
    if (!hasOtherDrives) {
      onPick(currentDriveId);
      return;
    }
    if (isOpen) {
      close();
    } else {
      setIsOpen(true);
      setActiveIndex(0);
    }
  }

  function handleOptionPick(driveId) {
    haptic("selection");
    close();
    onPick(driveId);
  }

  function handleMenuKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const opt = options[activeIndex];
      if (opt) handleOptionPick(opt.id);
    }
  }

  if (!hasOtherDrives) {
    return (
      <Button
        variant="outline"
        surface="secondary"
        size="sm"
        className="shrink-0"
        disabled={disabled}
        onClick={() => onPick(currentDriveId)}
      >
        {Icon ? <Icon size={14} className="mr-1" aria-hidden="true" /> : null}
        {label}
      </Button>
    );
  }

  return (
    <div ref={containerRef} className="relative inline-block shrink-0">
      <Button
        variant="outline"
        surface="secondary"
        size="sm"
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={handleTriggerClick}
        className="shrink-0 flex items-center gap-1.5"
      >
        {Icon ? <Icon size={14} aria-hidden="true" /> : null}
        <span>{label}</span>
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={cn(
            "motion-safe:transition-transform motion-safe:duration-200",
            isOpen && !isClosing ? "rotate-180" : "rotate-0",
          )}
        />
      </Button>

      {isOpen &&
        createPortal(
          <div
            ref={portalRef}
            role="menu"
            aria-label={`${label} destination`}
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "bg-secondary text-primary ring-inset ring-2 ring-accent",
              "rounded-large-element z-50 min-w-[14rem] max-w-[20rem] max-h-64 overflow-y-auto overscroll-contain shadow-lg",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            <div className="py-1">
              {options.map((opt, idx) => {
                const isFocused = idx === activeIndex;
                const isFirstOther = idx === 1;
                return (
                  <div key={opt.id}>
                    {isFirstOther && (
                      <div className="my-1 border-t border-primary/15" role="separator" />
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={cn(
                        "w-full flex items-center gap-2 px-3.5 py-2 text-xs text-left cursor-pointer",
                        "text-primary font-mono motion-safe:transition-colors motion-safe:duration-100",
                        isFocused ? "bg-primary/15" : "hover:bg-primary/10",
                      )}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => handleOptionPick(opt.id)}
                    >
                      {opt.isCurrent ? (
                        Icon ? (
                          <Icon size={13} className="text-accent shrink-0" aria-hidden="true" />
                        ) : null
                      ) : (
                        <HardDrive size={13} className="text-accent shrink-0" aria-hidden="true" />
                      )}
                      <span className="truncate">{opt.label}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

TransferMenu.propTypes = {
  label: PropTypes.string.isRequired,
  icon: PropTypes.elementType,
  drives: PropTypes.array,
  currentDriveId: PropTypes.string.isRequired,
  currentDriveLabel: PropTypes.string,
  onPick: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};
