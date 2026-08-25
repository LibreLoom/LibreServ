/* eslint-disable react-refresh/only-export-components -- recovery copy is shared with tests */
import { Keyboard } from "lucide-react";
import SettingsCard from "../SettingsCard";

/** Keep in lockstep with lunad `recovery::CARD_*` — printed-card copy. */
export const RECOVERY_CARD = {
  title: "If you forget your password",
  steps: [
    "Plug a USB keyboard into Luna.",
    "Press Esc, then type luna, then press Enter.",
    "On the screen plugged into Luna, type a new password twice.",
  ],
};

export default function PasswordCategory() {
  return (
    <SettingsCard icon={Keyboard} title={RECOVERY_CARD.title}>
      <ol className="space-y-2 text-sm text-primary list-decimal list-inside">
        {RECOVERY_CARD.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-primary">
        Keep this card somewhere safe. This only works with a keyboard plugged into Luna. Nobody can reset the password over the internet.
      </p>
    </SettingsCard>
  );
}
