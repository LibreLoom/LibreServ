import PropTypes from "prop-types";
import { PanelLeftClose, PanelLeftOpen, ChevronDown } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import Pill from "../common/Pill.jsx";
import SegmentedControl from "../common/SegmentedControl.jsx";
import ChatCreditBar from "./ChatCreditBar.jsx";

const PERMISSION_OPTIONS = [
  { value: "standard", label: "Standard" },
  { value: "approve_every_call", label: "Approve Each" },
];

function ModelPill({ value, options, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const containerRef = useRef(null);
  const portalRef = useRef(null);
  const buttonRef = useRef(null);

  const selected = options.find((o) => o.value === value);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    let left = rect.left + window.scrollX;
    if (left + rect.width > window.innerWidth - 8) {
      left = window.innerWidth - rect.width - 8;
    }
    setPosition({ top: rect.bottom + window.scrollY + 4, left });
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e) {
      if (containerRef.current?.contains(e.target) || portalRef.current?.contains(e.target)) return;
      setIsOpen(false);
    }
    function handleEscape(e) {
      if (e.key === "Escape") { setIsOpen(false); buttonRef.current?.focus(); }
    }
    function handleScroll() { if (isOpen) updatePosition(); }

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
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (isOpen) requestAnimationFrame(updatePosition);
  }, [isOpen, updatePosition]);

  function handleSelect(val) {
    onChange(val);
    setIsOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (!isOpen) updatePosition(); setIsOpen(!isOpen); }}
        className="bg-primary/10 rounded-pill px-2.5 py-1 text-xs font-mono text-primary inline-flex items-center gap-1.5 motion-safe:transition-colors hover:bg-primary/15 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Select model"
      >
        <span>{selected?.label || value}</span>
        <ChevronDown
          size={12}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && createPortal(
        <ul
          ref={portalRef}
          role="listbox"
          style={{ position: "absolute", top: position.top, left: position.left }}
          className="bg-secondary text-primary ring-inset ring-2 ring-accent rounded-large-element py-0 z-50 pop-in overflow-hidden min-w-[8rem] animate-dropdown-open"
          tabIndex={-1}
        >
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={value === opt.value}
                onClick={() => handleSelect(opt.value)}
                className={`w-full text-left px-4 py-2 text-xs motion-safe:transition-colors cursor-pointer ${
                  value === opt.value ? "bg-accent text-primary font-medium" : "hover:bg-primary/10"
                }`}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}

ModelPill.propTypes = {
  value: PropTypes.string.isRequired,
  options: PropTypes.arrayOf(PropTypes.shape({ value: PropTypes.string, label: PropTypes.string })).isRequired,
  onChange: PropTypes.func.isRequired,
};

/**
 * @param {{ model: any, onModelChange: any, modelOptions?: any, permissionMode: any, onPermissionModeChange: any, creditUsed: any, creditCap: any, planName: any, sidebarOpen: any, onToggleSidebar: any }} _
 */
function ChatHeader({
  model,
  onModelChange,
  modelOptions,
  permissionMode,
  onPermissionModeChange,
  creditUsed,
  creditCap,
  planName,
  sidebarOpen,
  onToggleSidebar,
}) {
  const resolvedModelOptions = modelOptions || [
    { value: "route/mimo-v2.5-pro", label: "Mimo v2.5 Pro" },
    { value: "route/kimi-k2.6", label: "Kimi K2.6" },
    { value: "route/deepseek-r1", label: "DeepSeek R1" },
  ];

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-primary/10">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="rounded-pill bg-primary/10 text-primary/50 hover:text-primary hover:bg-primary/15 motion-safe:transition-colors p-1.5 focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
      >
        {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
      </button>

      <ModelPill
        value={model || resolvedModelOptions[0].value}
        options={resolvedModelOptions}
        onChange={onModelChange}
      />

      <SegmentedControl
        options={PERMISSION_OPTIONS}
        value={permissionMode}
        onChange={onPermissionModeChange}
      />

      <div className="flex-1" />

      <ChatCreditBar used={creditUsed} cap={creditCap} planName={planName} />
    </div>
  );
}

ChatHeader.propTypes = {
  model: PropTypes.string,
  onModelChange: PropTypes.func,
  modelOptions: PropTypes.arrayOf(
    PropTypes.shape({ value: PropTypes.string, label: PropTypes.string })
  ),
  permissionMode: PropTypes.string.isRequired,
  onPermissionModeChange: PropTypes.func.isRequired,
  creditUsed: PropTypes.number,
  creditCap: PropTypes.number,
  planName: PropTypes.string,
  sidebarOpen: PropTypes.bool,
  onToggleSidebar: PropTypes.func,
};

export default ChatHeader;
