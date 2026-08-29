import { useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { getStripePromise } from "../billing/stripeConfig.js";
import { Button } from "./ui/button.jsx";

function appearanceFromTheme() {
  if (typeof window === "undefined") return { theme: "stripe" };
  const s = getComputedStyle(document.documentElement);
  const token = (name) => s.getPropertyValue(name).trim();
  const dark = document.documentElement.classList.contains("dark");
  return {
    theme: dark ? "night" : "stripe",
    variables: {
      colorPrimary: token("--foreground"),
      colorBackground: token("--secondary"),
      colorText: token("--secondary-foreground"),
      colorDanger: token("--palette-error"),
      borderRadius: "24px",
      fontFamily: token("--font-sans"),
    },
  };
}

function VerifyHumanCardForm({ onConfirm, loading, description, buttonLabel }) {
  const stripe = useStripe();
  const elements = useElements();
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLocalError("");
    if (!stripe || !elements) {
      setLocalError("The card form is still opening. Wait a moment and try again.");
      return;
    }
    setBusy(true);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setLocalError(submitError.message || "Check the card details and try again.");
        return;
      }
      const { error, paymentMethod } = await stripe.createPaymentMethod({ elements });
      if (error || !paymentMethod?.id) {
        setLocalError(error?.message || "We could not save the card. Try again.");
        return;
      }
      await onConfirm(paymentMethod.id);
    } catch (err) {
      setLocalError(err.message || "We could not take the dollar. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={handleSubmit} data-testid="verify-human-card">
      {description !== "" && (
        <p className="text-sm text-card-foreground">
          {description || "A dollar to confirm this is a real person; it counts toward cloud backup if you turn it on."}
        </p>
      )}
      <div className="rounded-large-element border border-border bg-secondary text-secondary-foreground p-4">
        <PaymentElement />
      </div>
      {localError && <p className="text-sm text-error">{localError}</p>}
      <Button type="submit" className="w-full" loading={loading || busy} disabled={!stripe}>
        {buttonLabel || "Confirm with a dollar"}
      </Button>
    </form>
  );
}

/**
 * @param {{
 *   account?: { stripe_publishable_key?: string } | null,
 *   onConfirm: (paymentMethodId: string) => Promise<void> | void,
 *   loading?: boolean,
 *   description?: string,
 *   buttonLabel?: string,
 * }} props
 */
export function VerifyHumanCard({ account, onConfirm, loading = false, description, buttonLabel }) {
  const stripe = getStripePromise(account);
  if (!stripe) {
    return (
      <p className="text-sm text-error">
        Card payments are not ready. Try again in a few minutes, or continue if this is a test setup.
      </p>
    );
  }
  return (
    <Elements
      stripe={stripe}
      options={{
        mode: "payment",
        amount: 100,
        currency: "usd",
        paymentMethodCreation: "manual",
        appearance: appearanceFromTheme(),
      }}
    >
      <VerifyHumanCardForm onConfirm={onConfirm} loading={loading} description={description} buttonLabel={buttonLabel} />
    </Elements>
  );
}
