import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle, XCircle, ChevronDown } from "lucide-react";
import Pill from "./Pill.jsx";
import { useSystemHealthCheck } from "../../hooks/useSystemHealthCheck.jsx";
import { haptic } from "../../utils/haptics.js";
import { displayLabel } from "../../lib/healthChecks.js";

/**
 * SystemHealthPill — failed health checks as a compact dashboard header pill,
 * mirroring LibreServ's CriticalIssues pattern.
 */
export default function SystemHealthPill() {
  const { data, isLoading, error } = useSystemHealthCheck();
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const containerRef = useRef(null);
  const buttonRef = useRef(null);
  const portalRef = useRef(null);

  const failedChecks = useMemo(() => {
    if (!data?.checks) return [];
    return Object.entries(data.checks)
      .filter(([, result]) => result?.status === "failed" || result?.status === "error")
      .map(([name, result]) => ({
        name,
        label: displayLabel(name, result),
        message: result?.message,
      }));
  }, [data]);

  const hasIssues = failedChecks.length > 0;

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = portalRef.current?.offsetWidth || 280;
      let left = rect.right + window.scrollX - menuWidth;
      if (left < 8) left = 8;
      setPosition({ top: rect.bottom + window.scrollY + 4, left });
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
    haptic("tap");
    if (isOpen) close();
    else setIsOpen(true);
  };

  if (isLoading) return null;
  if (error || !data) return null;

  if (!hasIssues) {
    return (
      <Pill variant="success" data-slot="system-health-pill">
        <CheckCircle size={12} strokeWidth={2.5} aria-hidden="true" />
        <span className="font-medium">All systems healthy</span>
      </Pill>
    );
  }

  const count = failedChecks.length;

  return (
    <div className="relative" ref={containerRef} data-slot="system-health-pill">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className={cn(
          "cursor-pointer motion-safe:transition-all active:motion-safe:scale-95",
          "no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
          "rounded-pill",
        )}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`${count} system issue${count !== 1 ? "s" : ""}. Click to view details.`}
      >
        <Pill variant="error" className="hover:brightness-110">
          <AlertTriangle size={12} strokeWidth={2.5} aria-hidden="true" />
          <span className="font-medium">
            {count} issue{count !== 1 ? "s" : ""}
          </span>
          <ChevronDown
            size={12}
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
            aria-label="System health issues"
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "bg-secondary text-primary ring-inset ring-2 ring-accent",
              "rounded-large-element py-0 z-50 overflow-hidden min-w-[16rem] max-w-[20rem]",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            <div className="px-4 py-3 border-b border-primary/10">
              <div className="flex items-center gap-2">
                <AlertTriangle size={16} className="text-error" aria-hidden="true" />
                <span className="font-mono text-sm font-medium text-error">
                  {count} issue{count !== 1 ? "s" : ""} found
                </span>
              </div>
            </div>
            <ul className="py-2">
              {failedChecks.map((check, i) => (
                <li
                  key={check.name}
                  className={isClosing ? "" : "animate-dropdown-option"}
                  style={isClosing ? undefined : { animationDelay: `${i * 45}ms` }}
                >
                  <div className="px-4 py-2 flex items-start gap-2">
                    <XCircle size={14} className="text-error mt-0.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="text-sm text-primary font-medium">{check.label}</div>
                      {check.message && (
                        <div className="text-xs text-accent mt-0.5 break-words">{check.message}</div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="px-4 py-3 border-t border-primary/10">
              <Link
                to="/settings#about"
                className="text-sm text-accent link-accent-card"
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
