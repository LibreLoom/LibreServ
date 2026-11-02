// @ts-nocheck -- deliberately replaces the browser's Date
// The scenario's "now". Time still moves (timers, animations) but starts from the
// scenario's date, and the same clock carries on after a full page load inside the
// frame: the base and the real moment it started are saved with the world.

// Captured once: freezing again (a hot reload, a second install) must not wrap the
// wrapper, and the log wants real time.
const RealDate = (globalThis.__lunaRealDate ??= globalThis.Date);

/** Real wall-clock milliseconds, never the frozen clock. */
export const realNow = () => RealDate.now();

/**
 * Pins "now". Pass a `resume` ({base, started}) to carry on an earlier clock.
 * Returns what to save so the clock can resume after a reload, or null when no
 * clock is pinned.
 */
export function freezeClock(base, resume) {
  if (!base) return null;
  const clock = resume?.base ? { base: resume.base, started: resume.started } : { base, started: realNow() };
  const current = () => clock.base + (realNow() - clock.started);
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(current());
      else super(...args);
    }
    static now() { return current(); }
  }
  window.Date = FrozenDate;
  return clock;
}
