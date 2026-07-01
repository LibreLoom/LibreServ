// Shared, non-component MFA constants. Kept in their own module so that
// MfaCard.jsx (which exports React components) doesn't also export plain
// constants — that breaks react-refresh/only-export-components (Fast Refresh
// only works when a file exports components exclusively).
//
// Consumed by MfaCard, the MfaSetupWizard, and EnrollFlow.

import {
  KeyRound,
  Mail,
  Fingerprint,
  Usb,
} from "lucide-react";

export const TYPE_META = {
  totp: { icon: KeyRound, label: "Authenticator app", desc: "An app like Authy, 1Password, or Google Authenticator" },
  email: { icon: Mail, label: "Email code", desc: "A one-time code sent to your email" },
  passkey: { icon: Fingerprint, label: "Passkey", desc: "Unlock with your device (Face ID, Touch ID, or Windows Hello)" },
  security_key: { icon: Usb, label: "Security key", desc: "A physical key you plug in or tap, like a YubiKey" },
};

export const ORDER = ["totp", "email", "passkey", "security_key"];

// Shared styles for inputs/buttons inside the inverted (bg-secondary) Card.
export const inputClass =
  "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/50 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

export const primaryButtonClass =
  "group w-full inline-flex items-center justify-center gap-2 rounded-pill bg-primary text-secondary py-3 font-mono text-sm tracking-wide motion-safe:transition-all motion-safe:duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none";

export const secondaryButtonClass =
  "w-full rounded-pill border border-primary/20 bg-transparent text-primary px-6 py-3 font-mono text-sm motion-safe:transition-all motion-safe:duration-200 hover:bg-primary/8";