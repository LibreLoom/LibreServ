import { useState, useEffect, useRef } from "react";

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

    fetch(`/api/v1/catalog/${appId}/icon?v=${Date.now()}`, { signal: controller.signal })
      .then((res) => res.text())
      .then((svgText) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (svgText.includes("<svg")) {
          const sized = svgText.replace(
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
      className={`inline-block align-middle ${className}`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}