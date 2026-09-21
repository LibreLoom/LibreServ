import { useEffect, useMemo, useRef, useState } from "react";

const CRYPTIC_GLYPHS = ["▓", "░", "▒", "█", "§", "%", "Ø", "#", "¤", "*", "0", "1", "Δ", "Ξ", "λ"];

/**
 * Animates in the selected domain char-by-char from the absolute left of the container
 * in REVERSE character order (e.g. for "kitchen": 'n' first, then 'e', 'h', 'c', 't', 'i', 'k'),
 * stepped char-by-char with normal font weight.
 * Once assembled, a wave of cryptic symbols sweeps through and erases all letters.
 *
 * Always shows .luna.servers.libreloom.org, centered assuming full length of the final domain name.
 *
 * @param {{ domain?: string }} props
 */
export function ProvisioningDomainAnimation({ domain = "kitchen" }) {
  const targetWord = useMemo(() => {
    const raw = (domain || "kitchen").toLowerCase().trim();
    const clean = raw.replace(/[^a-z0-9-]/g, "");
    return clean || "kitchen";
  }, [domain]);

  const chars = useMemo(() => targetWord.split(""), [targetWord]);
  const len = chars.length;

  // Order of insertion is reverse order:
  // e.g. for "kitchen" (len 7): indices 6, 5, 4, 3, 2, 1, 0
  const letterOrder = useMemo(() => {
    const order = [];
    for (let i = len - 1; i >= 0; i--) {
      order.push(i);
    }
    return order;
  }, [len]);

  const RUNWAY_STEPS = 12; // Run from absolute left of container

  // animation state
  const [phase, setPhase] = useState("sliding"); // "sliding" | "holding" | "erasing" | "pause"
  const [orderStep, setOrderStep] = useState(0); // 0 .. (len - 1)
  const [currentPos, setCurrentPos] = useState(0); // 0 .. (RUNWAY_STEPS + targetSlot)
  const [settledMap, setSettledMap] = useState({}); // slotIndex -> character
  const [eraseIdx, setEraseIdx] = useState(-1);
  const [eraseGlyph, setEraseGlyph] = useState("");

  const stateRef = useRef({
    phase: "sliding",
    orderStep: 0,
    pos: 0,
    settledMap: {},
    eraseIdx: -1,
    chars,
    letterOrder,
  });

  stateRef.current = {
    phase,
    orderStep,
    pos: currentPos,
    settledMap,
    eraseIdx,
    chars,
    letterOrder,
  };

  useEffect(() => {
    let timer = null;

    function tick() {
      const {
        phase: curPhase,
        orderStep: curOrderStep,
        pos: curPos,
        settledMap: curSettled,
        eraseIdx: curErase,
        letterOrder: curOrder,
        chars: curChars,
      } = stateRef.current;

      if (curPhase === "sliding") {
        const targetSlot = curOrder[curOrderStep];
        const maxPos = RUNWAY_STEPS + targetSlot;

        if (curPos < maxPos) {
          setCurrentPos(curPos + 1);
          timer = setTimeout(tick, 45);
        } else {
          // Reached its destination slot
          const nextSettled = {
            ...curSettled,
            [targetSlot]: curChars[targetSlot],
          };
          setSettledMap(nextSettled);

          if (curOrderStep + 1 < curOrder.length) {
            setOrderStep(curOrderStep + 1);
            setCurrentPos(0);
            timer = setTimeout(tick, 50);
          } else {
            // All letters assembled
            setPhase("holding");
            timer = setTimeout(() => {
              setPhase("erasing");
              setEraseIdx(0);
              const glyph =
                CRYPTIC_GLYPHS[Math.floor(Math.random() * CRYPTIC_GLYPHS.length)];
              setEraseGlyph(glyph);
              timer = setTimeout(tick, 70);
            }, 800);
          }
        }
      } else if (curPhase === "erasing") {
        if (curErase < curChars.length) {
          const nextErase = curErase + 1;
          setEraseIdx(nextErase);
          const glyph =
            CRYPTIC_GLYPHS[Math.floor(Math.random() * CRYPTIC_GLYPHS.length)];
          setEraseGlyph(glyph);

          if (nextErase >= curChars.length) {
            setPhase("pause");
            timer = setTimeout(() => {
              // Reset cycle
              setSettledMap({});
              setOrderStep(0);
              setCurrentPos(0);
              setEraseIdx(-1);
              setPhase("sliding");
              timer = setTimeout(tick, 300);
            }, 400);
          } else {
            timer = setTimeout(tick, 65);
          }
        }
      }
    }

    timer = setTimeout(tick, 50);
    return () => clearTimeout(timer);
  }, [chars, letterOrder]);

  // Build the slots
  const targetSlotNow = letterOrder[orderStep];
  const charInTransit =
    phase === "sliding" && orderStep < letterOrder.length
      ? chars[targetSlotNow]
      : null;

  return (
    <div
      className="w-full my-6 flex items-center justify-center overflow-hidden select-none"
      role="region"
      aria-label={`Provisioning domain ${targetWord}.luna.servers.libreloom.org`}
    >
      <div className="flex items-center font-mono text-sm sm:text-base font-normal tracking-normal">
        {/* Domain name slots container (fixed width matching exact final string length) */}
        <div className="relative flex items-center">
          {chars.map((char, slotIdx) => {
            let displayed = "\u00A0";

            if (phase === "sliding") {
              if (settledMap[slotIdx]) {
                displayed = settledMap[slotIdx];
              } else if (currentPos === RUNWAY_STEPS + slotIdx && charInTransit) {
                displayed = charInTransit;
              }
            } else if (phase === "holding") {
              displayed = settledMap[slotIdx] || char;
            } else if (phase === "erasing") {
              if (slotIdx < eraseIdx) {
                displayed = "\u00A0"; // erased
              } else if (slotIdx === eraseIdx) {
                displayed = eraseGlyph; // wave hit
              } else {
                displayed = settledMap[slotIdx] || char;
              }
            }

            return (
              <span
                key={slotIdx}
                className="inline-block w-[1ch] text-center font-normal text-foreground"
              >
                {displayed}
              </span>
            );
          })}

          {/* Letter currently traveling across runway (before reaching its target slot) */}
          {phase === "sliding" && charInTransit && currentPos < RUNWAY_STEPS && (
            <span
              className="absolute font-normal text-foreground pointer-events-none transition-none"
              style={{
                left: `-${(RUNWAY_STEPS - currentPos) * 1}ch`,
                width: "1ch",
                textAlign: "center",
              }}
            >
              {charInTransit}
            </span>
          )}
        </div>

        {/* Constant suffix: always there */}
        <span className="text-muted-foreground font-mono font-normal shrink-0">
          .luna.servers.libreloom.org
        </span>
      </div>
    </div>
  );
}
