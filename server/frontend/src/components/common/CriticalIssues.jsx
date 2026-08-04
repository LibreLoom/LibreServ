import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle, XCircle, ChevronDown } from "lucide-react";
import Pill from "./Pill";
import { useSystemHealthCheck } from "../../hooks/useSystemHealthCheck";
import { haptic } from "../../utils/haptics";

// Plain-language labels for technical health-check names (AGENTS.md
// plain-language rule: a non-technical user should not see "caddy_certs_writable").
const CHECK_LABELS = {
  disk_space: "Storage space",
  smtp: "Email delivery",
  caddy_certs_writable: "HTTPS certificate folder",
  caddy_admin_writable: "Web server config folder",
  caddy_config_writable: "Web server config file",
  acme_data_writable: "HTTPS certificate data",
  acme_certs_writable: "HTTPS certificate storage",
  database: "Database",
};

function labelFor(name) {
  return (
    CHECK_LABELS[name] ||
    String(name)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * CriticalIssues — surfaces failed system health checks as a compact pill in
 * the dashboard header. When issues exist, clicking the pill opens a dropdown
 * listing each problem in plain language. When everything is healthy, shows a
 * subtle success pill. Self-contained: calls useSystemHealthCheck internally.
 */
export default function CriticalIssues() {
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
      .filter(
        ([, result]) =>
          result?.status === "failed" || result?.status === "error",
      )
      .map(([name, result]) => ({
        name,
        label: labelFor(name),
        message: result?.message,
      }));
  }, [data]);

  const hasIssues = failedChecks.length > 0;

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = portalRef.current?.offsetWidth || 280;
      // Right-align the dropdown with the trigger button
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
      )
        return;
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
    if (isOpen) {
      close();
    } else {
      setIsOpen(true);
    }
  };

  // Render nothing while the health check runs — a "Checking…" label swaps to
  // the result pill and causes a layout shift in the header.
  if (isLoading) return null;

  // Silently ignore errors — non-critical for the dashboard
  if (error || !data) return null;

  if (!hasIssues) {
    return (
      <Pill variant="success" data-slot="critical-issues">
        <CheckCircle size={12} strokeWidth={2.5} aria-hidden="true" />
        <span className="font-mono font-medium">All systems healthy</span>
      </Pill>
    );
  }

  const count = failedChecks.length;

  return (
    <div className="relative" ref={containerRef} data-slot="critical-issues">
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
        aria-label={`${count} critical issue${count !== 1 ? "s" : ""}. Click to view details.`}
      >
        <Pill variant="error" className="hover:brightness-110">
          <AlertTriangle size={12} strokeWidth={2.5} aria-hidden="true" />
          <span className="font-mono font-medium">
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
            data-slot="critical-issues-dropdown"
            role="dialog"
            aria-label="Critical system issues"
            style={{ position: "absolute", top: position.top, left: position.left }}
            className={cn(
              "bg-secondary text-primary ring-inset ring-2 ring-accent",
              "rounded-large-element py-0 z-50 overflow-hidden min-w-[16rem] max-w-[20rem]",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open",
            )}
          >
            <div className="px-4 py-3 border-b border-primary/10">
              <div className="flex items-center gap-2">
                <AlertTriangle
                  size={16}
                  className="text-error"
                  aria-hidden="true"
                />
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
                    <XCircle
                      size={14}
                      className="text-error mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-primary font-medium">
                        {check.label}
                      </div>
                      {check.message && (
                        <div className="text-xs text-accent mt-0.5 break-words">
                          {check.message}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
