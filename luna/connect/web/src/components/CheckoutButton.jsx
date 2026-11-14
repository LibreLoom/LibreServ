import { useState } from "react";
import { startCheckout } from "../billing/checkout.js";
import { Button } from "./ui/button.jsx";

/**
 * Sends the person to Stripe's payment page. While the browser leaves, the
 * button stays busy. onDone runs when nothing needed paying (already paid, or a
 * test setup without Stripe).
 * @param {{
 *   kind: import("../billing/checkout.js").CheckoutKind,
 *   returnTo: import("../billing/checkout.js").CheckoutReturn,
 *   children: import("react").ReactNode,
 *   onDone?: () => unknown,
 *   onError?: (err: Error & { data?: any }) => unknown,
 *   loading?: boolean,
 *   className?: string,
 * }} props
 */
export function CheckoutButton({ kind, returnTo, children, onDone, onError, loading = false, className = "w-full" }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      size="lg"
      className={className}
      loading={loading || busy}
      data-testid={`checkout-${kind}`}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await startCheckout(kind, returnTo);
          if (res.done) {
            setBusy(false);
            await onDone?.();
          }
        } catch (err) {
          setBusy(false);
          onError?.(err);
        }
      }}
    >
      {children}
    </Button>
  );
}
