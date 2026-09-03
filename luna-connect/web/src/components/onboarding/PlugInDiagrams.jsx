/** US Type A/B power plug: two flat parallel blades and a round ground pin. */
export function PowerPlugDiagram({ className = "" }) {
  return (
    <svg
      viewBox="0 0 80 72"
      className={className}
      role="img"
      aria-label="US power plug"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M40 2v8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect
        x="18"
        y="10"
        width="44"
        height="26"
        rx="6"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="28"
        y="36"
        width="7"
        height="26"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="45"
        y="36"
        width="7"
        height="26"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="40" cy="58" r="3.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** RJ45 ethernet port: rectangular jack with contact pins and latch keying. */
export function EthernetDiagram({ className = "" }) {
  const pins = [26, 31.5, 37, 42.5, 48, 53.5, 59, 64.5];
  return (
    <svg
      viewBox="0 0 80 64"
      className={className}
      role="img"
      aria-label="RJ45 ethernet port"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="10"
        y="14"
        width="60"
        height="36"
        rx="5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="20"
        y="24"
        width="40"
        height="18"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M34 24h12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20 30h5v6h-5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {pins.map((x, i) => (
        <line
          key={x}
          x1={x}
          y1={38}
          x2={x}
          y2={i % 2 === 0 ? 44 : 42}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
