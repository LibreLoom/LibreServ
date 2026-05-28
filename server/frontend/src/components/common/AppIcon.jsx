import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import DOMPurify from "dompurify";

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName && data.attrName.startsWith("on")) {
    data.forceKeepAttr = false;
  }
});

const SVG_PURIFY_OPTS = {
  RETURN_DOM: true,
  ADD_TAGS: ["svg"],
  FORBID_TAGS: ["script", "foreignObject", "animate", "set"],
  FORBID_ATTR: ["onload", "onerror", "onclick"],
};

function sanitizeSVG(svgText) {
  if (!svgText || typeof svgText !== "string" || !svgText.includes("<svg")) {
    return "";
  }
  try {
    const clean = String(DOMPurify.sanitize(svgText, SVG_PURIFY_OPTS));
    const wrapper = document.createElement("div");
    wrapper.innerHTML = clean;
    return wrapper.innerHTML;
  } catch {
    return "";
  }
}

/**
 * @param {{ appId: any, size?: number, className?: string }} _
 */
export default function AppIcon({ appId, size = 48, className = "" }) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    fetch(/** @type {string} */ (`/api/v1/catalog/${appId}/icon?v=${Date.now()}`), { signal: controller.signal })
      .then((res) => res.text())
      .then((svgText) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (svgText.includes("<svg")) {
          const sanitized = sanitizeSVG(svgText);
          if (!sanitized) {
            setFailed(true);
            return;
          }
          const sized = sanitized.replace(
            /<svg/,
            `<svg width="${size}" height="${size}"`,
          );
          setSvg(sized);
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && mountedRef.current) {
          setFailed(true);
        }
      });

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [appId, size]);

  if (failed || !svg) {
    return (
      <div
        role="img"
        aria-label={`${appId} icon`}
        className={`rounded-large-element bg-secondary/10 flex items-center justify-center ${className}`}
        style={{ width: size, height: size }}
      >
        <span
          className="font-mono font-bold text-secondary/50"
          style={{ fontSize: size * 0.4 }}
        >
          {appId.charAt(0).toUpperCase()}
        </span>
      </div>
    );
  }

  return (
    <span
      role="img"
      aria-label={`${appId} icon`}
      className={`inline-block align-middle ${className}`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

AppIcon.propTypes = {
  appId: PropTypes.string.isRequired,
  size: PropTypes.number,
  className: PropTypes.string,
};