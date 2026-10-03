import { useState } from "react";
import { BellOff, EyeOff, Lightbulb, X } from "lucide-react";
import LayeredPill from "@libreloom/ui/components/ui/LayeredPill.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { dismissTip, setTipsEnabled, tipForSession, useTipState } from "../../lib/tips.js";

const DISMISS_OPTIONS = [
  { value: "this", label: "Hide this tip", icon: EyeOff },
  { value: "all", label: "Turn off all tips", icon: BellOff },
];

/**
 * TipPill — one short Luna tip in the dashboard header, with an X that opens
 * "Hide this tip" / "Turn off all tips". Renders nothing when there is no tip
 * for this visit. Settings → Appearance turns tips back on.
 */
export default function TipPill() {
  const { addToast } = useToast();
  const state = useTipState();
  const [tip] = useState(() => tipForSession());

  if (!tip || !state.enabled || state.dismissed.includes(tip.id)) return null;

  const onChoose = (choice) => {
    if (choice === "this") {
      dismissTip(tip.id);
    } else {
      setTipsEnabled(false);
      addToast({
        type: "success",
        message: "Tips are off.",
        description: "Turn them back on in Settings → Appearance.",
      });
    }
  };

  return (
    <Dropdown
      options={DISMISS_OPTIONS}
      value=""
      onChange={onChoose}
      renderTrigger={({ toggle, onKeyDown }) => (
        <div data-slot="tip-pill" onKeyDown={onKeyDown}>
          <LayeredPill
            icon={<Lightbulb size={ICON_SIZE.xs} aria-hidden="true" />}
            actionIcon={<X size={ICON_SIZE.xs} aria-hidden="true" />}
            actionLabel={<span className="sr-only">Hide tips</span>}
            actionAriaLabel="Hide tips"
            actionHaptic={false}
            onAction={toggle}
          >
            {tip.text}
          </LayeredPill>
        </div>
      )}
    />
  );
}
