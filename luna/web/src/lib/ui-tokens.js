/**
 * Shared design-system primitives for values that recur across many
 * components. Centralizing them here means the whole app moves together
 * when one of these changes, instead of drifting file-by-file.
 */

/**
 * The inline icon-size scale. Covers icons that appear next to text, in
 * buttons, or as small status/action glyphs. Larger one-off hero icons
 * (empty states, onboarding illustrations) are sized per page and are not
 * part of this shared scale.
 */
export const ICON_SIZE = {
  /** LayeredPill/LayeredCard's compact actionIcon slot only. */
  tight: 11,
  /** Micro-icons attached to text: link arrows, copy/check glyphs, tags. */
  xs: 12,
  /** The default inline icon next to a label or list row. */
  sm: 14,
  /** Icons inside controls: buttons, inputs, nav items. */
  md: 16,
  /** Section-header and modal-body icons. */
  lg: 18,
  /** Emphasis icons in modals/confirmations. */
  xl: 20,
  /** Large modal/banner header icons. */
  xxl: 24,
};

/** Placeholder text opacity for all text inputs. */
export const PLACEHOLDER_TEXT = "placeholder:text-primary/50";
