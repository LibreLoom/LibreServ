import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useSmoothResize } from "../../hooks/useSmoothResize.js";
import { haptic } from "../../utils/haptics.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";

/**
 * @typedef {object} DropdownOption
 * @property {string} value
 * @property {string} label
 * @property {import("react").ElementType} [icon]
 * @property {string} [group] Heading shown above the first option of each group (menu mode).
 * @property {boolean} [disabled] Greyed out and skipped by the arrow keys (menu mode).
 * @property {string} [sub] Second line under the label (menu mode).
 * @property {string} [note] Small text at the right edge (menu mode).
 * @property {import("react").ReactNode} [content] Replaces the label, `sub` and
 *   `note` inside the option's button (menu mode), for a row that animates.
 *   Keep `label` set: it is the fallback and what tests find.
 * @property {boolean} [keepOpen] Picking it runs `onChange` but leaves the menu
 *   open (menu mode). The caller owns the haptic, since the row's own action
 *   usually has a stronger one.
 */

/**
 * @typedef {object} DropdownProps
 * @property {Array<DropdownOption>} options
 *   `icon` draws before the label in the menu.
 * @property {(trigger: { open: boolean, toggle: () => void, onKeyDown: (e: import("react").KeyboardEvent) => void }) => import("react").ReactNode} [renderTrigger]
 *   Replace the pill with your own control (an action button that opens a
 *   menu). The menu, positioning, cascade, and outside-click close are the
 *   same. Wire `toggle` to its click and `onKeyDown` for arrow keys.
 * @property {string} value
 * @property {(value: string) => void} onChange
 * @property {string} [placeholder]
 * @property {string} [label]
 * @property {"primary"|"secondary"} [surface] Pill color. Prefer `bg` at call sites.
 * @property {"primary"|"secondary"} [bg] Alias for `surface`. On a card/modal (`surface-secondary`)
 *   use `bg="primary"` (page-bg pill). On page background use `bg="secondary"`.
 * @property {boolean} [fullWidth]
 * @property {boolean} [disabled]
 * @property {boolean} [ghost]
 * @property {import("react").ComponentType<any>} [icon] Render the trigger as an
 *   icon-only button (toolbar menus) instead of a labeled pill. Pair with
 *   `aria-label`.
 * @property {"start"|"end"} [align] Which edge of the trigger the menu lines up with. Default "start".
 * @property {string} [className]
 * @property {string} [triggerClassName]
 * @property {"default"|"form"} [size]
 * @property {string} [id]
 * @property {boolean} [menu] Action menu instead of a value picker: `role="menu"`,
 *   no selected state, and `onChange` fires with the picked option's value.
 *   Arrow keys on the trigger open it and move through it.
 * @property {string} [menuLabel] Accessible name of the menu list.
 * @property {import("react").ReactNode} [menuHeader] Controls shown above the
 *   options inside the menu (menu mode), such as a segmented control. Clicks in
 *   it never close the menu.
 * @property {boolean} [open] Controlled open state (drag-hover opens, shortcuts).
 *   Changes follow the prop; `onOpenChange` reports the other direction.
 * @property {(open: boolean) => void} [onOpenChange]
 * @property {(option: DropdownOption) => (import("react").ButtonHTMLAttributes<HTMLButtonElement> & { className?: string }) | undefined} [optionProps]
 *   Extra props for one option's button (drag handlers, highlight classes).
 */

/** @param {DropdownProps & { [key: string]: any }} props */
export default function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select...",
  label,
  surface,
  bg,
  fullWidth = false,
  disabled = false,
  ghost = false,
  icon: Icon,
  renderTrigger,
  align = "start",
  className = "",
  triggerClassName = "",
  size = "default",
  variant = "default",
  id,
  menu = false,
  menuLabel,
  menuHeader,
  open: openProp,
  onOpenChange,
  optionProps,
  "aria-label": ariaLabel,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef(null);
  const portalRef = useRef(null);
  const buttonRef = useRef(null);
  useSmoothResize(buttonRef, { x: !fullWidth && !renderTrigger });

  const isForm = size === "form" || variant === "form";
  const selectedOption = options.find((o) => o.value === value);
  const pill = bg || surface || "secondary";
  // Ghost keeps the backdrop, so it sets only the text color that reads on it.
  const surfaceClass = ghost
    ? `bg-transparent ${pill === "primary" ? "text-secondary" : "text-primary"}`
    : `surface-${pill}`;
  const hoverClass = ghost
    ? `hover:bg-${pill === "primary" ? "secondary" : "primary"}/10`
    : "";
  const formBorderClass = isForm
    ? pill === "primary"
      ? "border-2 border-secondary/30 hover:border-secondary/50 focus:border-accent"
      : "border-2 border-primary/30 hover:border-primary/50 focus:border-accent"
    : "";

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = portalRef.current?.offsetWidth || rect.width;
      let left = (align === "end" ? rect.right - menuWidth : rect.left) + window.scrollX;
      if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
      if (left < 8) left = 8;
      const next = { top: rect.bottom + window.scrollY + 4, left, width: rect.width };
      setPosition((prev) => (prev.top === next.top && prev.left === next.left && prev.width === next.width ? prev : next));
    }
  }, [align]);

  // A custom trigger sits inside a span — focus the control inside it.
  const focusTrigger = useCallback(() => {
    const el = buttonRef.current;
    const target = el?.matches?.("button") ? el : el?.querySelector?.("button");
    (target || el)?.focus?.();
  }, []);

  const closeTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const close = useCallback(() => {
    setIsClosing(true);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setIsOpen(false);
      setIsClosing(false);
      setActiveIndex(-1);
    }, 160);
    onOpenChangeRef.current?.(false);
  }, []);

  const openMenu = useCallback(() => {
    // Reopening mid-close-animation cancels the pending close.
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    updatePosition();
    setIsClosing(false);
    setIsOpen(true);
    onOpenChangeRef.current?.(true);
  }, [updatePosition]);

  // A controlled `open` drives the menu; internal opens report back above.
  useEffect(() => {
    if (openProp === undefined) return;
    if (openProp && (!isOpen || isClosing)) openMenu();
    else if (!openProp && isOpen && !isClosing) close();
    // Only a change of the prop should act; isOpen/isClosing are read, not triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProp]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event) {
      if (containerRef.current?.contains(event.target) || portalRef.current?.contains(event.target)) return;
      close();
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        close();
        focusTrigger();
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
  }, [isOpen, updatePosition, close, focusTrigger]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
    if (portalRef.current) updatePosition();
  }, [isOpen, updatePosition]);

  const handleSelect = (optionValue) => {
    if (menu && options.find((o) => o.value === optionValue)?.keepOpen) {
      onChange(optionValue);
      return;
    }
    haptic("selection");
    onChange(optionValue);
    close();
    focusTrigger();
  };

  const handleToggle = () => {
    if (disabled) return;
    haptic("light");
    if (isOpen && !isClosing) {
      close();
    } else {
      openMenu();
    }
  };

  const enabledIndexes = options.flatMap((o, i) => (o.disabled ? [] : [i]));
  const stepActive = (dir) => {
    if (!enabledIndexes.length) return;
    const at = enabledIndexes.indexOf(activeIndex);
    const next = at === -1
      ? (dir > 0 ? 0 : enabledIndexes.length - 1)
      : (at + dir + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  };

  const handleKeyDown = (event) => {
    if (!isOpen || isClosing) {
      // Menus open from the keyboard on the trigger itself.
      if (menu && !disabled && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        haptic("light");
        openMenu();
        setActiveIndex(event.key === "ArrowDown" ? (enabledIndexes[0] ?? -1) : (enabledIndexes.at(-1) ?? -1));
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stepActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      stepActive(-1);
    } else if ((event.key === "Enter" || (menu && event.key === " ")) && activeIndex >= 0 && !options[activeIndex]?.disabled) {
      event.preventDefault();
      handleSelect(options[activeIndex].value);
    }
  };

  return (
    <div className={cn(renderTrigger ? "relative inline-flex" : "relative", fullWidth && "w-full", className)} ref={containerRef}>
      {renderTrigger ? (
        <span ref={buttonRef} className="inline-flex">
          {renderTrigger({ open: isOpen && !isClosing, toggle: handleToggle, onKeyDown: handleKeyDown })}
        </span>
      ) : (
      <button
        ref={buttonRef}
        id={id}
        type="button"
        data-slot="dropdown-trigger"
        onClick={handleToggle}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        className={cn(
          "items-center cursor-pointer rounded-pill",
          isForm
            ? "py-2 px-5 min-h-[42px] text-sm text-left outline-none"
            : Icon
              ? "justify-center p-1.5"
              : "gap-1.5 min-h-[34px] px-3.5 py-1.5 text-xs",
          "motion-safe:transition-[background-color,color,border-color,box-shadow,scale,opacity] no-focus-outline",
          "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
          `focus-visible:ring-offset-${pill}`,
          "active:motion-safe:scale-95 disabled:opacity-50 disabled:cursor-not-allowed",
          fullWidth ? "w-full inline-flex" : "inline-flex",
          surfaceClass,
          isForm ? "" : Icon ? "" : ghost ? "font-mono" : "font-medium",
          formBorderClass,
          hoverClass,
          triggerClassName,
        )}
        aria-expanded={isOpen}
        aria-haspopup={menu ? "menu" : "listbox"}
        aria-label={ariaLabel || (label ? `${label}: ${selectedOption?.label || "select"}` : undefined)}
      >
        {Icon ? (
          <Icon size={ICON_SIZE.md} aria-hidden="true" />
        ) : (
          <>
            {label && !ghost && <span className="opacity-70">{label}</span>}
            <span
              className={cn(
                "inline-flex items-center gap-1 whitespace-nowrap",
                isForm ? "font-normal text-sm" : ghost ? "" : "font-mono",
                fullWidth && "justify-between w-full",
              )}
            >
              {selectedOption?.label || placeholder}
              <ChevronDown
                size={isForm ? ICON_SIZE.md : ICON_SIZE.sm}
                className={cn(
                  "motion-safe:transition-transform motion-safe:duration-300 shrink-0",
                  isOpen && !isClosing ? "rotate-180" : "rotate-0",
                )}
                style={{ transitionTimingFunction: "var(--motion-easing-emphasized)" }}
                aria-hidden="true"
              />
            </span>
          </>
        )}
      </button>
      )}

      {isOpen &&
        createPortal(
          <div
            ref={portalRef}
            data-slot="dropdown-menu"
            style={{
              position: "absolute",
              top: position.top,
              left: position.left,
              ...(fullWidth && position.width ? { minWidth: `${position.width}px` } : {}),
            }}
            className={cn(
              "z-[100]",
              isClosing ? "animate-dropdown-close" : "animate-dropdown-open"
            )}
          >
            <ul
              role={menu ? "menu" : "listbox"}
              aria-label={menu ? menuLabel : undefined}
              className={cn(
                "surface-secondary font-mono",
                // overflow-y-auto alone would compute overflow-x as auto too,
                // so the 2px hover slide on options showed a horizontal
                // scrollbar. Clip x; the slide stays, clipped at the menu edge.
                "rounded-large-element py-0 max-h-64 overflow-y-auto overflow-x-hidden overscroll-contain min-w-[8rem] inner-scrollbar",
                menu && "min-w-[12rem] max-h-72",
              )}
              tabIndex={-1}
            >
              {menu && menuHeader ? (
                <li role="none" data-slot="dropdown-header" className={cn("px-4 pt-3", options.length ? "pb-2" : "pb-3")}>
                  {menuHeader}
                </li>
              ) : null}
              {options.map((option, i) => {
                const { className: extraClass, ...extraProps } = optionProps?.(option) || {};
                const showGroup = menu && option.group && option.group !== options[i - 1]?.group;
                const selected = !menu && value === option.value;
                return (
                  <li
                    key={option.value}
                    role="none"
                    data-slot="dropdown-option"
                    className={isClosing ? "" : "animate-dropdown-option"}
                    style={isClosing ? undefined : { animationDelay: `${Math.min(i * (menu ? 45 : 30), 240)}ms` }}
                  >
                    {showGroup ? (
                      <p className="px-4 pt-2.5 pb-1 font-mono text-xs text-primary">{option.group}</p>
                    ) : null}
                    <button
                      type="button"
                      role={menu ? "menuitem" : "option"}
                      aria-selected={menu ? undefined : selected}
                      disabled={option.disabled}
                      onMouseEnter={menu && !option.disabled ? () => setActiveIndex(i) : undefined}
                      onClick={() => handleSelect(option.value)}
                      {...extraProps}
                      className={cn(
                        "w-full text-left px-4 py-2 motion-safe:transition-[background-color,color,translate] motion-safe:duration-150 motion-safe:ease-out",
                        menu ? "text-sm" : "text-xs",
                        (option.icon || menu) && "flex items-center gap-2",
                        "cursor-pointer rounded-none",
                        option.disabled
                          ? "cursor-not-allowed opacity-50"
                          : selected
                            ? "surface-primary font-medium"
                            : i === activeIndex
                              ? "bg-primary/10 motion-safe:translate-x-0.5"
                              : "hover:bg-primary/10 hover:motion-safe:translate-x-0.5",
                        extraClass,
                      )}
                    >
                      {option.icon ? <option.icon size={ICON_SIZE.sm} aria-hidden="true" className="shrink-0" /> : null}
                      {menu && option.content ? (
                        option.content
                      ) : menu && (option.sub || option.note) ? (
                        <>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{option.label}</span>
                            {option.sub ? <span className="block truncate text-xs font-sans">{option.sub}</span> : null}
                          </span>
                          {option.note ? (
                            <span className="max-w-[10rem] shrink-0 truncate font-mono text-xs">{option.note}</span>
                          ) : null}
                        </>
                      ) : (
                        option.label
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-large-element ring-2 ring-inset ring-accent"
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
