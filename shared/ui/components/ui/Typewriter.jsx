import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils.js";

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** @param {string} a @param {string} b */
function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * The text typed out one letter at a time. When `text` changes, letters the
 * old and new text share stay put and only the rest is typed, so a status line
 * that grows ("Reading 2 of 3" → "Reading 3 of 3") doesn't start over.
 * Everything appears at once for people who prefer reduced motion.
 *
 * @param {string} text
 * @param {{ speed?: number, enabled?: boolean, onDone?: () => void }} [options]
 *   `speed` is milliseconds per letter.
 * @returns {{ shown: string, typing: boolean }}
 */
export function useTypewriter(text, { speed = 24, enabled = true, onDone } = {}) {
  const instant = !enabled || prefersReducedMotion();
  const [shown, setShown] = useState(instant ? text : "");
  const shownLen = useRef(instant ? text.length : 0);
  const previous = useRef(instant ? text : "");
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      previous.current = text;
      shownLen.current = text.length;
      setShown(text);
      return undefined;
    }
    let i = Math.min(shownLen.current, commonPrefix(previous.current, text));
    previous.current = text;
    shownLen.current = i;
    setShown(text.slice(0, i));
    if (i >= text.length) return undefined;
    const id = setInterval(() => {
      i += 1;
      shownLen.current = i;
      setShown(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(id);
        done.current?.();
      }
    }, speed);
    return () => clearInterval(id);
  }, [text, speed, enabled]);

  return { shown, typing: shown.length < text.length };
}

/**
 * Cycles through `phrases`: types one, holds, erases it, types the next.
 * Stops (showing the first phrase in full) for reduced motion, or the empty
 * string while `active` is false.
 *
 * @param {string[]} phrases
 * @param {{ active?: boolean, typeSpeed?: number, eraseSpeed?: number, hold?: number }} [options]
 * @returns {string}
 */
export function useTypewriterCycle(
  phrases,
  { active = true, typeSpeed = 48, eraseSpeed = 22, hold = 1600 } = {},
) {
  const [text, setText] = useState("");
  const key = phrases.join("\n");

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (!active || list.length === 0) {
      setText("");
      return undefined;
    }
    if (prefersReducedMotion()) {
      setText(list[0]);
      return undefined;
    }
    let timer = 0;
    let index = 0;
    let len = 0;
    /** @param {() => void} fn @param {number} ms */
    const later = (fn, ms) => {
      timer = window.setTimeout(fn, ms);
    };
    const type = () => {
      len += 1;
      setText(list[index].slice(0, len));
      if (len >= list[index].length) later(erase, hold);
      else later(type, typeSpeed);
    };
    const erase = () => {
      len -= 1;
      setText(list[index].slice(0, Math.max(len, 0)));
      if (len <= 0) {
        index = (index + 1) % list.length;
        later(type, typeSpeed * 4);
      } else {
        later(erase, eraseSpeed);
      }
    };
    later(type, typeSpeed * 3);
    return () => window.clearTimeout(timer);
  }, [key, active, typeSpeed, eraseSpeed, hold]);

  return text;
}

/**
 * Text that types itself out. Screen readers get the whole sentence at once
 * rather than a letter at a time.
 *
 * @param {{
 *   text: string,
 *   speed?: number,
 *   enabled?: boolean,
 *   cursor?: boolean,
 *   as?: import('react').ElementType,
 *   className?: string,
 *   onDone?: () => void,
 * }} props
 */
export default function Typewriter({
  text,
  speed = 24,
  enabled = true,
  cursor = true,
  as: Tag = "span",
  className = "",
  onDone,
}) {
  const { shown, typing } = useTypewriter(text, { speed, enabled, onDone });
  return (
    <Tag data-slot="typewriter" className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {shown}
        {cursor && typing && (
          <span className={cn("ml-px inline-block w-[0.5ch] border-b-2 border-accent align-baseline motion-safe:animate-pulse")}>
            {" "}
          </span>
        )}
      </span>
    </Tag>
  );
}

Typewriter.propTypes = {
  text: PropTypes.string.isRequired,
  speed: PropTypes.number,
  enabled: PropTypes.bool,
  cursor: PropTypes.bool,
  as: PropTypes.elementType,
  className: PropTypes.string,
  onDone: PropTypes.func,
};
