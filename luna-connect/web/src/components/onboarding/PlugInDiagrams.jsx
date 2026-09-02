/** Simple line-art: barrel plug and cable into an RJ45-style port. */
export function PowerPlugDiagram({ className = "" }) {
  return (
    <svg
      viewBox="0 0 120 80"
      className={className}
      role="img"
      aria-label="Power cable plugged into Luna"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="8" y="28" width="44" height="24" rx="6" stroke="currentColor" strokeWidth="2" />
      <path d="M52 40h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect x="70" y="22" width="42" height="36" rx="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="82" cy="40" r="3" fill="currentColor" />
      <path d="M20 52v14M36 52v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Simple line-art: RJ45 plug and ethernet cable. */
export function EthernetDiagram({ className = "" }) {
  return (
    <svg
      viewBox="0 0 120 80"
      className={className}
      role="img"
      aria-label="RJ45 ethernet cable plugged into Luna"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 34h28l6 12h20l6-12h28"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <rect x="34" y="46" width="52" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M42 50h4M50 50h4M58 50h4M66 50h4M74 50h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 34v-10M98 34v-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect x="70" y="18" width="42" height="36" rx="8" stroke="currentColor" strokeWidth="2" />
      <rect x="82" y="30" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
