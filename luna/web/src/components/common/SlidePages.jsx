import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AnimatePresence, motion as Motion, useReducedMotion } from "motion/react";

// Pages move like a carousel, the way their selector reads: going to a page
// further along pushes the old one out to the left and the new one follows in
// from the right. A short spring lets the new page settle quickly.
//
// `transform` itself is animated, not Motion's `x` shorthand: Motion hands a
// `transform` animation to the browser (WAAPI), which runs it on the
// compositor, so the slide stays smooth while the new page renders on the main
// thread. At rest the page returns to `transform: none`; a held transform would
// make it the containing block for any fixed-position piece inside it.
const SLIDE = {
  enter: (/** @type {number} */ dir) => ({ transform: `translateX(${100 * dir}%)`, opacity: 0.6 }),
  shown: { transform: "translateX(0%)", opacity: 1, transitionEnd: { transform: "none" } },
  leave: (/** @type {number} */ dir) => ({ transform: `translateX(${-100 * dir}%)`, opacity: 0.6 }),
};
/** @type {import("motion/react").Transition} */
const SPRING = { type: "spring", duration: 0.24, bounce: 0.06 };
const INSTANT = { duration: 0 };
// The entrances a page's own pieces would play on mount (index.css). A page
// sliding in already moves, so they wait until it lands.
const ENTRANCES = ".animate-nav-slide-in, .animate-cascade-in";

/**
 * Which way a change moves: compare positions element by element; the first
 * difference decides. Equal positions (another page at the same spot) move
 * forward.
 * @param {number|number[]} from
 * @param {number|number[]} to
 */
function slideDirection(from, to) {
  const a = [from].flat();
  const b = [to].flat();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 1;
}

/**
 * Slides between pages: one page per `pageKey`, the old one leaving the way
 * the new one's `position` says while the new one comes in.
 *
 * - Both pages share one grid cell, so neither drops out of the flow and the
 *   box keeps the taller page's height until the old one has gone.
 * - The direction is set once per page change and held, so a re-render
 *   mid-slide (data arriving) never turns the leaving page around.
 * - Every page keeps its place on screen through a switch. The new page starts
 *   at the top of the scroller and the leaving page is lifted by the distance
 *   scrolled, so it slides out where it was; a page called back mid-slide
 *   scrolls back to where it was instead. The box clips its top edge while a
 *   page is shifted, so it can't cover what sits above.
 * - Put everything that belongs to a page inside it: anything above the box
 *   that appears or disappears with the page moves both pages mid-slide.
 *
 * @param {{
 *   pageKey: string,
 *   position: number|number[],
 *   children: import("react").ReactNode,
 *   scrollRef?: import("react").RefObject<HTMLElement|null>,
 *   className?: string,
 *   pageClassName?: string,
 *   innerClassName?: string,
 *   onPageChange?: () => void,
 *   onSettled?: () => void,
 * }} props
 */
export default function SlidePages({
  pageKey,
  position,
  children,
  scrollRef,
  className = "",
  pageClassName = "",
  innerClassName,
  onPageChange,
  onSettled,
}) {
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState({ key: pageKey, position, dir: 1, moved: false });
  if (shown.key !== pageKey) {
    setShown({ key: pageKey, position, dir: slideDirection(shown.position, position), moved: true });
  }
  const dir = shown.dir;

  const boxRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const scrollAt = useRef(0);
  const lastKey = useRef(pageKey);
  const latest = useRef({ onPageChange, onSettled });
  latest.current = { onPageChange, onSettled };

  // Scroll as of the last scroll event, so a page change still knows where
  // the reader was after the new page's height has clamped it.
  useEffect(() => {
    const el = scrollRef?.current ?? null;
    const target = el ?? window;
    const read = () => {
      scrollAt.current = el ? el.scrollTop : window.scrollY;
    };
    read();
    target.addEventListener("scroll", read, { passive: true });
    return () => target.removeEventListener("scroll", read);
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (lastKey.current === pageKey) return;
    lastKey.current = pageKey;
    const box = boxRef.current;
    if (!box) return;
    const el = scrollRef?.current ?? null;
    const readY = () => (el ? el.scrollTop : window.scrollY);
    const pages = /** @type {HTMLElement[]} */ ([...box.children]);
    const liftOf = (/** @type {Element|null} */ inner) => Number(/** @type {HTMLElement|null} */ (inner)?.dataset.lift) || 0;
    const coming = pages.find((page) => page.dataset.slidePage === pageKey);
    const target = liftOf(coming?.firstElementChild ?? null);
    const before = scrollAt.current;
    if (before !== target) (el ?? window).scrollTo({ top: target, behavior: "instant" });
    const scrollY = readY();
    const moved = Math.round(before - scrollY);
    scrollAt.current = scrollY;
    let anyShifted = false;
    for (const page of pages) {
      const inner = /** @type {HTMLElement|null} */ (page.firstElementChild);
      if (!inner) continue;
      const oldLift = liftOf(inner);
      const lift = page === coming ? 0 : oldLift + moved;
      if (lift !== 0) {
        anyShifted = true;
      }
      if (lift === oldLift) continue;
      if (lift !== 0) {
        inner.dataset.lift = String(lift);
        inner.style.transform = `translateY(${-lift}px)`;
      } else {
        delete inner.dataset.lift;
        inner.style.transform = "";
      }
    }
    box.style.clipPath = anyShifted ? "inset(0 0 -100000px 0)" : "";
    latest.current.onPageChange?.();
  }, [pageKey, scrollRef]);

  // A page that slid in already showed its pieces; switch their entrance off
  // for good before lifting the hold, or each would play it again as the page
  // lands. Pieces that mount later (the next batch of photos) keep theirs.
  const handleShown = useCallback((/** @type {string} */ key) => {
    const page = /** @type {HTMLElement[]} */ ([...(boxRef.current?.children || [])]).find(
      (el) => el.dataset.slidePage === key,
    );
    if (!page?.hasAttribute("data-entering")) return;
    for (const el of page.querySelectorAll(ENTRANCES)) {
      /** @type {HTMLElement} */ (el).style.animation = "none";
    }
    page.removeAttribute("data-entering");
  }, []);

  const handleSettled = useCallback(() => {
    if (boxRef.current) boxRef.current.style.clipPath = "";
    latest.current.onSettled?.();
  }, []);

  return (
    <div ref={boxRef} className={`-mx-1 grid overflow-x-clip px-1 ${className}`}>
      <AnimatePresence initial={false} custom={dir} onExitComplete={handleSettled}>
        <Motion.div
          key={pageKey}
          data-slide-page={pageKey}
          data-entering={shown.moved && !reduceMotion ? "" : undefined}
          custom={dir}
          variants={SLIDE}
          initial={reduceMotion ? false : "enter"}
          animate="shown"
          exit="leave"
          transition={reduceMotion ? INSTANT : SPRING}
          onAnimationComplete={(name) => {
            if (name === "shown") handleShown(pageKey);
          }}
          className={`col-start-1 row-start-1 min-w-0 ${pageClassName}`}
        >
          <div className={innerClassName}>{children}</div>
        </Motion.div>
      </AnimatePresence>
    </div>
  );
}

SlidePages.propTypes = {
  pageKey: PropTypes.string.isRequired,
  position: PropTypes.oneOfType([PropTypes.number, PropTypes.arrayOf(PropTypes.number)]).isRequired,
  children: PropTypes.node,
  scrollRef: PropTypes.shape({ current: PropTypes.any }),
  className: PropTypes.string,
  pageClassName: PropTypes.string,
  innerClassName: PropTypes.string,
  onPageChange: PropTypes.func,
  onSettled: PropTypes.func,
};
