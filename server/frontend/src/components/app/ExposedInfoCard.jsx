import { useState, useRef, useEffect } from "react";
import Card from "../cards/Card";
import { Eye, EyeOff, Copy, Check, Key, Link, Lock, ChevronDown } from "lucide-react";

const GROUP_LABELS = {
  credentials: { label: "Credentials", icon: Lock },
  connection: { label: "Connection Details", icon: Link },
};

const GROUP_ORDER = ["credentials", "connection"];

function AdvancedSection({ show, onToggle, advancedSortedGroups, advancedGrouped, renderGroup }) {
  const contentRef = useRef(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    }
  }, [show, advancedSortedGroups]);

  const contentId = "advanced-info-content";

  return (
    <div className="mt-8 pt-8 border-t border-dashed border-secondary/15">
      <button
        onClick={onToggle}
        className="group flex w-full items-center justify-between gap-3 rounded-large-element px-4 py-3 text-left font-mono text-sm text-secondary/50 hover:bg-secondary/5 motion-safe:transition-all"
        aria-expanded={show}
        aria-controls={contentId.current}
      >
        <span className="uppercase tracking-wider text-xs">Advanced Information</span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-secondary/40 motion-safe:transition-transform motion-safe:duration-300 ${
            show ? "rotate-180" : ""
          }`}
        />
      </button>

      <div
        ref={contentRef}
        id={contentId.current}
        className="overflow-hidden motion-safe:transition-[max-height,opacity] motion-safe:duration-500 motion-safe:ease-in-out"
        style={{ maxHeight: show ? `${height}px` : "0px", opacity: show ? 1 : 0 }}
        role="region"
        aria-label="Advanced information"
      >
        <div
          className="mt-4 border-l-2 border-secondary/10 pl-6"
        >
          {advancedSortedGroups.map((gk) => renderGroup(gk, advancedGrouped, true))}
        </div>
      </div>
    </div>
  );
}

export function ExposedInfoCard({ info }) {
  const [revealed, setRevealed] = useState({});
  const [copied, setCopied] = useState({});
  const [hoverReveal, setHoverReveal] = useState({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toggleReveal = (key) => {
    setRevealed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = async (key, value) => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setCopied((prev) => ({ ...prev, [key]: false })), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const renderValue = (field, key) => {
    const value = String(field.value ?? "");
    const placeholderValue = value || "secret-value";
    const isPinnedRevealed = Boolean(revealed[key]);
    const isHoverRevealed = Boolean(hoverReveal[key]);
    const isVisible = isPinnedRevealed || isHoverRevealed;

    const handleMaskedValueClick = () => {
      if (window.matchMedia("(hover: hover)").matches) {
        if (field.copyable && field.value) {
          copyToClipboard(key, field.value);
        }
        return;
      }

      setHoverReveal((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    if (field.type === "url" && field.value) {
      return (
        <a
          href={String(field.value)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {String(field.value)}
        </a>
      );
    }

    if (field.mask_by_default) {
      return (
        <span
          className={`relative grid md:inline-grid w-full md:w-auto min-w-0 align-middle ${
            field.copyable ? "cursor-copy" : "cursor-pointer"
          }`}
          onClick={handleMaskedValueClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setHoverReveal((prev) => ({ ...prev, [key]: !prev[key] }));
            }
          }}
          onMouseEnter={() => {
            if (window.matchMedia("(hover: hover)").matches) {
              setHoverReveal((prev) => ({ ...prev, [key]: true }));
            }
          }}
          onMouseLeave={() => {
            if (window.matchMedia("(hover: hover)").matches) {
              setHoverReveal((prev) => ({ ...prev, [key]: false }));
            }
          }}
          role="button"
          tabIndex={0}
          aria-label={isVisible ? `Hide ${field.label || "value"}` : `Reveal ${field.label || "value"}`}
        >
          <span
            className={`
              invisible col-start-1 row-start-1 px-4 py-2
              font-mono text-sm whitespace-pre-wrap break-all
            `}
          >
            {placeholderValue}
          </span>
          <span
            className={`
              col-start-1 row-start-1 flex items-center justify-center md:justify-start overflow-hidden rounded-full
              border border-secondary/15 bg-secondary/5 px-4 py-2 w-full
              transition-[opacity,transform,filter] duration-300 ease-out
              ${isVisible ? "opacity-0 scale-95 blur-md" : "opacity-100 scale-100 blur-0"}
            `}
          >
            <span
              className={`
                font-mono text-sm text-secondary/45 select-none whitespace-pre-wrap break-all
                transition-[opacity,filter] duration-300 ease-out
                ${isVisible ? "opacity-0 blur-md" : "opacity-100 blur-[8px]"}
              `}
            >
              {placeholderValue}
            </span>
            <span
              className={`
                pointer-events-none absolute inset-0 hidden md:flex items-center justify-center px-4
                transition-[opacity,transform] duration-300 ease-out
                ${isVisible ? "opacity-0 scale-95" : "opacity-100 scale-100"}
              `}
            >
              <span className="rounded-full bg-primary/65 px-2 py-0.5 font-mono text-[10px] tracking-wide text-secondary shadow-sm">
                hover to reveal
              </span>
            </span>
          </span>
          <span
            className={`
              col-start-1 row-start-1 flex items-center overflow-hidden rounded-full w-full
              border border-secondary/15 bg-secondary/5 px-4 py-2
              transition-[opacity,transform,filter] duration-300 ease-out
              ${isVisible ? "opacity-100 scale-100 blur-0" : "opacity-0 scale-[1.02] blur-sm"}
            `}
          >
            <span className="font-mono text-sm text-secondary whitespace-pre-wrap break-all">
              {value}
            </span>
          </span>
        </span>
      );
    }

    return <span className="font-mono text-secondary">{String(field.value ?? "")}</span>;
  };

  const entries = Object.entries(info || {});
  if (entries.length === 0) {
    return null;
  }

  const basicEntries = entries.filter(([_, field]) => !field.advanced);
  const advancedEntries = entries.filter(([_, field]) => field.advanced);

  const groupByGroup = (fieldEntries) => {
    return fieldEntries.reduce((acc, [key, field]) => {
      const group = field.group || "other";
      if (!acc[group]) acc[group] = [];
      acc[group].push([key, field]);
      return acc;
    }, {});
  };

  const sortGroups = (groupedObj) => {
    return Object.keys(groupedObj).sort((a, b) => {
      const aIdx = GROUP_ORDER.indexOf(a);
      const bIdx = GROUP_ORDER.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
  };

  const renderGroup = (groupKey, groupedObj, isAdvanced = false) => {
    const fields = groupedObj[groupKey];
    const groupMeta = GROUP_LABELS[groupKey] || {
      label: groupKey.charAt(0).toUpperCase() + groupKey.slice(1),
      icon: Key,
    };
    const GroupIcon = groupMeta.icon;

    return (
      <div key={groupKey} className="mb-8 last:mb-0">
        <div className="flex items-center gap-2 mb-4">
          <GroupIcon size={16} className={isAdvanced ? "text-secondary/40" : "text-accent"} />
          <h3
            className={`
              text-sm font-mono uppercase tracking-wider
              ${isAdvanced ? "text-secondary/40" : "text-accent"}
            `}
          >
            {groupMeta.label}
          </h3>
        </div>
        <div className="space-y-0">
          {fields.map(([key, field]) => (
            <div
              key={key}
              className={`
                flex flex-col gap-3 py-4 border-b last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4
                ${isAdvanced ? "border-secondary/5" : "border-secondary/10"}
              `}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p
                    className={`
                    text-sm font-medium
                    ${isAdvanced ? "text-secondary/60" : "text-secondary"}
                  `}
                  >
                    {field.label}
                  </p>
                  {field.advanced && (
                    <span className="rounded-full border border-secondary/15 bg-secondary/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-tighter text-secondary/40">
                      Advanced
                    </span>
                  )}
                </div>
                {field.description && (
                  <p
                    className={`
                    text-xs mt-1
                    ${isAdvanced ? "text-secondary/30" : "text-secondary/50"}
                  `}
                  >
                    {field.description}
                  </p>
                )}
                <div className="mt-3">{renderValue(field, key)}</div>
              </div>
              <div className="flex gap-2 shrink-0 self-end sm:self-auto">
                {field.revealable && (
                  <button
                    onClick={() => toggleReveal(key)}
                    className="p-2 rounded-pill hover:bg-secondary/10 transition-colors text-secondary/60 hover:text-secondary"
                    aria-label={revealed[key] ? `Hide ${field.label}` : `Reveal ${field.label}`}
                  >
                    {revealed[key] ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                )}
                {field.copyable && (
                  <button
                    onClick={() => copyToClipboard(key, field.value)}
                    className="p-2 rounded-pill hover:bg-secondary/10 transition-colors text-secondary/60 hover:text-secondary"
                    aria-label={`Copy ${field.label} to clipboard`}
                  >
                    {copied[key] ? (
                      <Check size={16} className="text-success" />
                    ) : (
                      <Copy size={16} />
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const basicGrouped = groupByGroup(basicEntries);
  const basicSortedGroups = sortGroups(basicGrouped);

  const advancedGrouped = groupByGroup(advancedEntries);
  const advancedSortedGroups = sortGroups(advancedGrouped);

  return (
    <section className="mt-8">
      <Card className="bg-primary! text-secondary! border-2! border-secondary!">
        <div className="flex items-center gap-2 mb-8">
          <Key size={20} className="text-accent" />
          <h2 className="text-2xl font-mono font-normal">Exposed Information</h2>
        </div>

        {basicSortedGroups.map((gk) => renderGroup(gk, basicGrouped))}

        {advancedEntries.length > 0 && (
          <AdvancedSection
            show={showAdvanced}
            onToggle={() => setShowAdvanced(!showAdvanced)}
            advancedSortedGroups={advancedSortedGroups}
            advancedGrouped={advancedGrouped}
            renderGroup={renderGroup}
          />
        )}
      </Card>
    </section>
  );
}
