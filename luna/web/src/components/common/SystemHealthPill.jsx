import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { cn } from "@libreloom/ui/lib/utils.js";
import { AlertTriangle, ChevronDown } from "lucide-react";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { useSystemHealthCheck } from "../../hooks/useSystemHealthCheck.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { warningChecks } from "../../lib/needsYouChecks.js";
import CheckStatusIcon from "./CheckStatusIcon.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

/**
 * SystemHealthPill — warning health checks (a feature that won't work) as a
 * compact dashboard header pill, mirroring Sol's CriticalIssues pattern.
 * Failed checks are not listed here: they are rows in Needs you. With no
 * warnings the pill renders nothing.
 */
export default function SystemHealthPill() {
  const { data, isLoading, error } = useSystemHealthCheck();
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const containerRef = useRef(null);
  const buttonRef = useRef(null);
  const portalRef = useRef(null);

  const issues = useMemo(() => warningChecks(data), [data]);

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = portalRef.current?.offsetWidth || 280;
      let left = rect.right + window.scrollX - menuWidth;
      if (left < 8) left = 8;
      const next = { top: rect.bottom + window.scrollY + 4, left };
      setPosition((prev) => (prev.top === next.top && prev.left === next.left ? prev : next));
    }
  }, []);

  const close = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
    }, 160);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
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
        close();
        buttonRef.current?.focus();
      }
    }
    function handleScroll() {
      updatePosition();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [isOpen, updatePosition, close]);

  useEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, updatePosition]);

  const handleToggle = () => {
    haptic("light");
    if (isOpen) close();
    else setIsOpen(true);
  };

  if (isLoading) return null;
  if (error || !data) return null;

  const count = issues.length;
  if (count === 0) return null;

  const countText = `${count} warning${count !== 1 ? "s" : ""}`;

  return (
    <div className="relative" ref={containerRef} data-slot="system-health-pill" data-header-item>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className={cn(
          "cursor-pointer motion-safe:transition-[scale] active:motion-safe:scale-95",
          "no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
          "rounded-pill",
        )}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`${countText}. Click to view details.`}
      >
        <Pill variant="warning" className="hover:brightness-110">
          <AlertTriangle size={ICON_SIZE.xs} strokeWidth={2.5} aria-hidden="true" />
          <span className="font-medium">{countText}</span>
          <ChevronDown
            size={ICON_SIZE.xs}
            className={cn(
              "motion-safe:transition-transform motion-safe:duration-300",
              isOpen && !isClosing ? "rotate-180" : "rotate-0",
            )}
            aria-hidden="true"
          />
        </Pill>
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={portalRef}
            data-slot="system-health-dropdown"
            role="dialog"
            aria-label="System health warnings"
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "surface-secondary ring-inset ring-2 ring-accent",
              "rounded-large-element py-0 z-50 overflow-hidden min-w-[16rem] max-w-[20rem]",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            <div className="px-4 py-3 border-b border-primary/10">
              <div className="flex items-center gap-2">
                <CheckStatusIcon status="warning" size="sm" />
                <span className="font-mono text-sm text-primary">
                  {countText} found
                </span>
              </div>
            </div>
            <ul className="py-2">
              {issues.map((check, i) => (
                <li
                  key={check.name}
                  className={isClosing ? "" : "animate-dropdown-option"}
                  style={isClosing ? undefined : { animationDelay: `${i * 45}ms` }}
                >
                  <div className="px-4 py-2 flex items-start gap-2">
                    <CheckStatusIcon status="warning" size="sm" className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-sm text-primary font-medium">{check.label}</div>
                      {check.message && (
                        <div className="text-xs mt-0.5 break-words">{check.message}</div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="px-4 py-3 border-t border-primary/10">
              <Link
                to="/settings#about"
                className="text-sm link-accent-card"
                onClick={close}
              >
                Open system checks in Settings
              </Link>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
