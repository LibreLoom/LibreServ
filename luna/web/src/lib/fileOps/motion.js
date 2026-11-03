// The file card's motion vocabulary. Every transition in the card and inside
// it draws from this file, so the whole surface moves like one thing: the same
// spring, the same travel, the same exit. Motion that isn't here is a bug.
//
// Three rules the numbers encode:
//
// 1. **Entering is slower than leaving.** Something arriving is worth
//    watching; something going away should be out of the way. Entrances ride
//    the spring; exits are ~180ms and never bounce.
// 2. **Travel is small.** Lines move 8px, not 40. The card sits over a page
//    someone is using; a big slide would read as a page change, not a task.
// 3. **Only discrete changes animate.** A percentage counting up must never
//    animate — it would re-trigger every emit. The meta line and the collapsed
//    summary therefore fade in and out as a whole, but their changing numbers
//    are left alone.
//
// `MotionConfig reducedMotion="user"` at the dock turns all of it off for
// anyone who asked for less motion — the layout still lands correctly, it just
// does so instantly.

/** @type {import("motion/react").Transition} */
export const SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 };

/** The card itself: a little softer than a line, because it is bigger. */
/** @type {import("motion/react").Transition} */
export const DOCK_SPRING = { type: "spring", stiffness: 380, damping: 38, mass: 1 };

/** Exits. Fast, no overshoot. */
/** @type {[number, number, number, number]} */
const EASE_OUT = [0.3, 0, 1, 1];

/** @type {import("motion/react").Transition} */
export const EXIT = { duration: 0.18, ease: EASE_OUT };

/** A row leaving gets a touch longer, so the eye can follow it out. */
/** @type {import("motion/react").Transition} */
export const EXIT_SLOW = { duration: 0.22, ease: EASE_OUT };

// -- the card ----------------------------------------------------------------

export const DOCK_HIDDEN = { opacity: 0, y: 28, scale: 0.94 };
export const DOCK_SHOWN = { opacity: 1, y: 0, scale: 1 };
export const DOCK_EXIT = { opacity: 0, y: 20, scale: 0.96, transition: EXIT };

// -- rows --------------------------------------------------------------------

/** A row arriving grows into the space it needs instead of shoving the rest. */
export const ROW_HIDDEN = { opacity: 0, height: 0, y: -8, scale: 0.98 };
export const ROW_SHOWN = { opacity: 1, height: "auto", y: 0, scale: 1 };
export const ROW_EXIT = { opacity: 0, height: 0, y: -6, scale: 0.98, transition: EXIT_SLOW };

// -- lines inside a row ------------------------------------------------------

/**
 * A line under the status line: a progress bar, a meta counter, a problem, an
 * error. It carries its own top gap so a collapsed line leaves no hole — the
 * row stacks with no `space-y`, and the gap is part of the animated height.
 */
export const LINE_HIDDEN = { opacity: 0, height: 0, marginTop: 0, x: -8 };
export const LINE_SHOWN = { opacity: 1, height: "auto", marginTop: 8, x: 0 };
export const LINE_EXIT = { opacity: 0, height: 0, marginTop: 0, x: 8, transition: EXIT };

/** The progress bar unfolds from its own bottom edge, so it reads as part of the row. */
export const BAR_HIDDEN = { opacity: 0, height: 0, marginTop: 0, scaleY: 0.2 };
export const BAR_SHOWN = { opacity: 1, height: "auto", marginTop: 8, scaleY: 1 };
export const BAR_EXIT = { opacity: 0, height: 0, marginTop: 0, scaleY: 0.2, transition: EXIT };

/**
 * One item changing what it is: a running upload becoming a name clash, a
 * clash becoming a retry, a failure running again. The old shape leaves
 * upward and the new one rises from below, so the row reads as the same file
 * moving on rather than two rows swapping.
 */
export const ITEM_HIDDEN = { opacity: 0, height: 0, marginTop: 0, y: 10 };
export const ITEM_SHOWN = { opacity: 1, height: "auto", marginTop: 8, y: 0 };
export const ITEM_EXIT = { opacity: 0, height: 0, marginTop: 0, y: -10, transition: EXIT };

// -- text that swaps ---------------------------------------------------------

/** A status line changing its words: the old rise out, the new rise in. */
/** @type {import("motion/react").Transition} */
export const TEXT_EXIT = { duration: 0.16, ease: EASE_OUT };

/**
 * The incoming words. A spring, so a swap has the same small overshoot as
 * everything else in the card rather than a linear slide.
 */
/** @type {import("motion/react").Transition} */
export const TEXT_SWAP = { type: "spring", stiffness: 560, damping: 40, mass: 0.8 };

// -- the progress bar --------------------------------------------------------

/** The fill itself: a spring, so a jump in progress glides instead of snapping. */
/** @type {import("motion/react").Transition} */
export const BAR_FILL = { type: "spring", stiffness: 260, damping: 34, mass: 0.7 };
