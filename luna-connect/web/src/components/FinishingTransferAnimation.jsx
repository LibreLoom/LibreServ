import { useEffect, useState } from "react";

const PACKETS_LTR = [
  "0x8F4A >> TUNNEL::SYN >> ▓▒░Δ >> 1024",
  "CONNECT_DNS >> 7e4a::acme >> ●─●─● >> 0x1B",
  "ESTABLISH >> §λ-ROUTE >> ¤#* >> CF_RAY",
];

const PACKETS_RTL = [
  "<< 200::ACK << §§λ-PACKET::4096 << ▓█",
  "<< TLS_HANDSHAKE::OK << ░▒▓ << 0x9F",
  "<< ROUTE::VERIFIED << ▓▒░ << KEEP_ALIVE",
];

const GLYPHS = ["▓", "░", "▒", "█", "§", "%", "Ø", "#", "¤", "*", "0", "1", "Δ", "Ξ", "λ"];

/**
 * Official Cloudflare brand mark (two-tone flame + cloud emblem from cloudflare-docs).
 * Backed by a solid silhouette matching its exact geometry so text disappears
 * strictly under the colored shape of the emblem.
 */
function CloudflareLogo({ className = "w-20 h-10" }) {
  return (
    <svg
      role="img"
      viewBox="0 0 66 30"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Cloudflare"
    >
      {/* Opaque card-colored underlay strictly matching Cloudflare geometry */}
      <path
        className="fill-card"
        d="M53.12 13.125c6.997 0 12.668 5.708 12.668 12.75 0 1.255-.18 2.468-.516 3.614a.72.72 0 0 1-.694.511H46.953a.375.375 0 0 1-.348-.51l.337-.882c1.076-2.833 4.146-5.154 6.987-5.29l5.384-.277a.543.543 0 0 0 .514-.544.543.543 0 0 0-.51-.544l-5.056-.299c-2.718-.14-4.046-2.56-3.315-5.081l.842-2.902a.72.72 0 0 1 .646-.527q.34-.02.686-.019"
      />
      <path
        className="fill-card"
        d="M35.609 0c7.295 0 13.424 5.025 15.157 11.824.073.285.05.586-.054.862l-1.388 3.677c-1.076 2.833-3.842 5.29-6.97 5.29l-24.105.278a.533.533 0 0 0-.525.535c0 .293.234.531.524.535l23.765.316c2.724 0 4.046 2.56 3.316 5.081l-.307 1.061a.75.75 0 0 1-.716.541H.964a.71.71 0 0 1-.718-.646 11 11 0 0 1-.034-.854c0-5.476 4.166-9.973 9.482-10.456a7.2 7.2 0 0 1-.167-1.544c0-3.935 3.17-7.125 7.08-7.125 1.555 0 2.994.506 4.162 1.362C22.849 4.497 28.707 0 35.609 0"
      />
      {/* Official colored brand mark paths */}
      <path
        fill="#FF9910"
        d="M53.12 13.125c6.997 0 12.668 5.708 12.668 12.75 0 1.255-.18 2.468-.516 3.614a.72.72 0 0 1-.694.511H46.953a.375.375 0 0 1-.348-.51l.337-.882c1.076-2.833 4.146-5.154 6.987-5.29l5.384-.277a.543.543 0 0 0 .514-.544.543.543 0 0 0-.51-.544l-5.056-.299c-2.718-.14-4.046-2.56-3.315-5.081l.842-2.902a.72.72 0 0 1 .646-.527q.34-.02.686-.019"
      />
      <path
        fill="#FF5F08"
        d="M35.609 0c7.295 0 13.424 5.025 15.157 11.824.073.285.05.586-.054.862l-1.388 3.677c-1.076 2.833-3.842 5.29-6.97 5.29l-24.105.278a.533.533 0 0 0-.525.535c0 .293.234.531.524.535l23.765.316c2.724 0 4.046 2.56 3.316 5.081l-.307 1.061a.75.75 0 0 1-.716.541H.964a.71.71 0 0 1-.718-.646 11 11 0 0 1-.034-.854c0-5.476 4.166-9.973 9.482-10.456a7.2 7.2 0 0 1-.167-1.544c0-3.935 3.17-7.125 7.08-7.125 1.555 0 2.994.506 4.162 1.362C22.849 4.497 28.707 0 35.609 0"
      />
    </svg>
  );
}

/**
 * Official LibreServ / Luna brand emblem.
 */
function LibreServLogo({ className = "w-16 h-16" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 240 240"
      className={className}
      fill="none"
      aria-label="LibreServ"
    >
      {/* Outer subtle border */}
      <rect x="0" y="0" width="240" height="240" rx="32" fill="#767676" />
      {/* Crisp surface */}
      <rect x="2" y="2" width="236" height="236" rx="30" className="fill-card" />
      {/* Iconic bottom-right circle marker */}
      <circle cx="200" cy="200" r="24" className="fill-foreground" stroke="#767676" strokeWidth="2" />
    </svg>
  );
}

/**
 * Cinematic data transfer animation between LibreServ and Cloudflare.
 *
 * Spans the full width of the outer card (ignoring inner padding):
 * - LibreServ logo is partially clipped by the left outer edge of the card
 * - Official Cloudflare logo is partially clipped by the right outer edge of the card
 * - Cryptic data packets stream continuously between the two nodes
 */
export function FinishingTransferAnimation() {
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setPulseKey((k) => (k + 1) % 100);
    }, 450);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      className="relative w-full h-36 sm:h-40 my-6 flex items-center justify-between select-none"
      role="region"
      aria-label="Connecting Luna to Cloudflare domain"
    >
      {/* Left Node: LibreServ logo */}
      <div
        className="relative z-20 flex items-center shrink-0 pl-1 pointer-events-none"
        aria-hidden="true"
      >
        <LibreServLogo className="w-14 h-14 sm:w-16 sm:h-16 drop-shadow-md" />
      </div>

      {/* Center: Travelling cryptic data strings running between logos.
          The text itself stays razor-sharp and un-morphed across the middle.
          A gradient mask dissolves text to 0 opacity inside the SVG zones. */}
      <div
        className="absolute inset-0 z-10 flex flex-col justify-center gap-3 overflow-hidden font-mono text-xs text-muted-foreground pointer-events-none"
        style={{
          maskImage:
            "linear-gradient(to right, transparent 0%, transparent 14%, black 28%, black 72%, transparent 86%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent 0%, transparent 14%, black 28%, black 72%, transparent 86%, transparent 100%)",
        }}
      >
        {/* Track 1: Left to Right (Luna -> Cloudflare) */}
        <div className="relative h-6 flex items-center overflow-hidden">
          <div
            className="whitespace-nowrap absolute flex items-center gap-6"
            style={{
              animation: "stream-ltr 5.5s linear infinite backwards",
              animationDelay: "0.2s",
            }}
          >
            <span className="text-foreground/90 font-medium tracking-wide">
              {PACKETS_LTR[0]}
            </span>
            <span className="text-muted-foreground text-[11px] inline-block">
              {GLYPHS[pulseKey % GLYPHS.length]}
              {GLYPHS[(pulseKey + 2) % GLYPHS.length]}
              {GLYPHS[(pulseKey + 4) % GLYPHS.length]}
            </span>
            <span className="text-foreground/90 font-medium tracking-wide">
              {PACKETS_LTR[1]}
            </span>
          </div>
        </div>

        {/* Track 2: Right to Left (Cloudflare -> Luna) */}
        <div className="relative h-6 flex items-center overflow-hidden">
          <div
            className="whitespace-nowrap absolute flex items-center gap-6"
            style={{
              animation: "stream-rtl 6s linear infinite backwards",
              animationDelay: "1.4s",
            }}
          >
            <span className="text-foreground font-medium tracking-wide">
              {PACKETS_RTL[0]}
            </span>
            <span className="text-muted-foreground text-[11px] inline-block">
              {GLYPHS[(pulseKey + 1) % GLYPHS.length]}
              {GLYPHS[(pulseKey + 3) % GLYPHS.length]}
            </span>
            <span className="text-foreground font-medium tracking-wide">
              {PACKETS_RTL[1]}
            </span>
          </div>
        </div>

        {/* Track 3: Left to Right (Luna -> Cloudflare) */}
        <div className="relative h-6 flex items-center overflow-hidden">
          <div
            className="whitespace-nowrap absolute flex items-center gap-6"
            style={{
              animation: "stream-ltr 5.2s linear infinite backwards",
              animationDelay: "2.6s",
            }}
          >
            <span className="text-foreground/80 tracking-wide">
              {PACKETS_LTR[2]}
            </span>
            <span className="text-muted-foreground text-[11px] inline-block">
              {GLYPHS[(pulseKey + 5) % GLYPHS.length]}
              {GLYPHS[(pulseKey + 7) % GLYPHS.length]}
            </span>
            <span className="text-foreground/80 tracking-wide">
              {PACKETS_RTL[2]}
            </span>
          </div>
        </div>
      </div>

      {/* Localized boundary morph & blur lenses:
          Positioned strictly at the transition zones where strings enter and reach the SVGs.
          Characters passing underneath get progressively liquefied, blurred, and faded out,
          leaving the entire middle stretch clear and unaffected. */}
      <div
        className="absolute inset-y-0 left-12 sm:left-14 w-20 sm:w-24 z-15 pointer-events-none backdrop-blur-[6px]"
        style={{
          maskImage: "linear-gradient(to right, black 25%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to right, black 25%, transparent 100%)",
        }}
      />
      <div
        className="absolute inset-y-0 right-12 sm:right-16 w-20 sm:w-24 z-15 pointer-events-none backdrop-blur-[6px]"
        style={{
          maskImage: "linear-gradient(to left, black 25%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to left, black 25%, transparent 100%)",
        }}
      />

      {/* Right Node: Official Cloudflare emblem */}
      <div
        className="relative z-20 flex items-center shrink-0 pr-1 pointer-events-none"
        aria-hidden="true"
      >
        <CloudflareLogo className="w-18 h-9 sm:w-20 sm:h-10 drop-shadow-md" />
      </div>
    </div>
  );
}
