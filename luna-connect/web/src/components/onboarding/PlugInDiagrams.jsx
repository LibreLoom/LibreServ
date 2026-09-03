/** US Type A/B power plug: plug body, two flat blades, round ground pin. */
export function PowerPlugDiagram({ className = "" }) {
  return (
    <svg
      viewBox="0 0 80 80"
      className={className}
      role="img"
      aria-label="US power plug"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Cable stub */}
      <path d="M40 6v10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      {/* Plug body */}
      <rect
        x="20"
        y="14"
        width="40"
        height="28"
        rx="7"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* NEMA flat blades */}
      <rect
        x="28"
        y="42"
        width="6"
        height="24"
        rx="1"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="46"
        y="42"
        width="6"
        height="24"
        rx="1"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Round ground pin (longer tip) */}
      <line
        x1="40"
        y1="42"
        x2="40"
        y2="68"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="40" cy="70" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** RJ45 ethernet port: face-on jack with latch notch and eight contacts. */
export function EthernetDiagram({ className = "" }) {
  // Eight contact positions across the jack opening (evenly spaced).
  const pins = [26, 31, 36, 41, 46, 51, 56, 61];
  return (
    <svg
      viewBox="0 0 80 80"
      className={className}
      role="img"
      aria-label="RJ45 ethernet port"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Device faceplate */}
      <rect
        x="8"
        y="18"
        width="64"
        height="44"
        rx="6"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Jack opening */}
      <rect
        x="18"
        y="28"
        width="44"
        height="24"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Top latch / keying notch */}
      <path
        d="M34 28v4h12v-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Left keying shoulder */}
      <path
        d="M18 34h6v8h-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Contact pins inside the opening */}
      {pins.map((x, i) => (
        <line
          key={x}
          x1={x}
          y1={48}
          x2={x}
          y2={i % 2 === 0 ? 44 : 45.5}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
