// OTP code entry field built on the input-otp library (rodz/input-otp).
// Renders a segmented single-input OTP: one slot per digit, with paste
// support, SMS autofill, and a fake blinking caret (the native caret is
// transparent). Styled to match the Simplex Mono design language — pill
// surfaces, theme tokens, monospace digits.
//
// Usage:
//   <OtpInput value={code} onChange={setCode} maxLength={6} />
//
// For variable-length freeform codes (recovery codes), keep a plain <input>;
// this component is for fixed-length numeric codes.

import { OTPInput } from "input-otp";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";

/**
 * @param {{
 *   value?: string,
 *   onChange?: (v: string) => void,
 *   maxLength?: number,
 *   onComplete?: (...args: any[]) => unknown,
 *   disabled?: boolean,
 *   autoFocus?: boolean,
 *   id?: string,
 *   className?: string,
 * } | undefined} [props]
 */
export default function OtpInput({
  value,
  onChange,
  maxLength = 6,
  onComplete,
  disabled = false,
  autoFocus = false,
  id,
  className,
} = {}) {
  return (
    <OTPInput
      // `id` lands on the real <input> (input-otp forwards unknown props to it),
      // so <label htmlFor={id}> works and screen readers announce the label.
      id={id}
      maxLength={maxLength}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      // numeric codes only — invalid keystrokes/pastes are dropped, not filtered.
      pattern="^\d+$"
      inputMode="numeric"
      // Per-slot placeholder: a dimmed hash (#) in each empty slot.
      // input-otp fills each slot with successive chars from `placeholder`,
      // so we pad "#" to the full length → ### ### across the grouped slots.
      // The accessible label lives on the parent <label htmlFor={id}>.
      placeholder={"#".repeat(maxLength)}
      // center so taps land on a sensible slot on mobile.
      textAlign="center"
      containerClassName={cn(
        "group flex items-center justify-center gap-2 has-[:disabled]:opacity-50",
        className,
      )}
      render={({ slots }) => {
        // Group slots into halves separated by a dash (Stripe-style ### — ###).
        const mid = Math.ceil(slots.length / 2);
        const left = slots.slice(0, mid);
        const right = slots.slice(mid);
        return (
          <div className="flex items-center gap-2">
            <SlotGroup slots={left} />
            {right.length > 0 && <FakeDash />}
            <SlotGroup slots={right} />
          </div>
        );
      }}
    />
  );
}

/**
 * One visible cell of the OTP field. input-otp hands us char/placeholderChar/
 * isActive/hasFakeCaret and gets out of the way; everything below is plain
 * markup. The real caret is transparent, so we draw a fake one when the slot
 * is active and empty.
 */
function Slot({ char, placeholderChar, isActive, hasFakeCaret }) {
  return (
    <div
      className={cn(
        // Pill surface (Simplex Mono) — rounded-pill, theme tokens, mono digits.
        "relative flex h-14 w-10 sm:w-12 items-center justify-center",
        "font-mono text-lg tabular-nums text-primary",
        "border-2 border-primary/20 bg-transparent rounded-large-element",
        "motion-safe:transition-all motion-safe:duration-150",
        // The group-* hooks come from containerClassName="group …" on OTPInput.
        "group-hover:border-primary/40 group-focus-within:border-accent",
        "group-focus-within:ring-1 group-focus-within:ring-accent",
        // Active slot lifts to the front + accent border.
        isActive && "border-accent ring-1 ring-accent z-10",
      )}
    >
      <div className="group-has-[input[data-input-otp-placeholder-shown]]:text-primary/30">
        {char ?? placeholderChar}
      </div>
      {hasFakeCaret && <FakeCaret />}
    </div>
  );
}

/** Blinking bar — the native caret is transparent, so we draw our own. */
function FakeCaret() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="h-7 w-px bg-accent animate-otp-caret-blink" />
    </div>
  );
}

/** A run of adjacent slots — a sub-group within the field (e.g. left half). */
function SlotGroup({ slots }) {
  return (
    <div className="flex items-center gap-2">
      {slots.map((slot, idx) => (
        <Slot key={idx} {...slot} />
      ))}
    </div>
  );
}

/** Stripe-style dash between two groups of slots. */
function FakeDash() {
  return (
    <div aria-hidden className="flex w-3 items-center justify-center">
      <div className="h-0.5 w-3 rounded-full bg-primary/30" />
    </div>
  );
}

SlotGroup.propTypes = {
  slots: PropTypes.arrayOf(PropTypes.object).isRequired,
};

OtpInput.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  maxLength: PropTypes.number,
  disabled: PropTypes.bool,
  autoFocus: PropTypes.bool,
  id: PropTypes.string,
  className: PropTypes.string,
};

Slot.propTypes = {
  char: PropTypes.string,
  placeholderChar: PropTypes.string,
  isActive: PropTypes.bool,
  hasFakeCaret: PropTypes.bool,
};
