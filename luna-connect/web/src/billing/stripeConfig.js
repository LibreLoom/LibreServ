import { loadStripe } from "@stripe/stripe-js";

/**
 * Publishable key for the card form. Build-time env, or a runtime value
 * the account payload may start returning in parallel with the backend work.
 * @param {{ stripe_publishable_key?: string } | null | undefined} account
 */
export function stripePublishableKey(account) {
  const fromAccount = account?.stripe_publishable_key;
  if (typeof fromAccount === "string" && fromAccount.startsWith("pk_")) {
    return fromAccount;
  }
  const fromEnv = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
  if (typeof fromEnv === "string" && fromEnv.startsWith("pk_")) {
    return fromEnv;
  }
  return "";
}

/** @param {{ stripe_publishable_key?: string } | null | undefined} account */
export function stripeLooksConfigured(account) {
  return stripePublishableKey(account) !== "";
}

/** @type {ReturnType<typeof loadStripe> | null} */
let stripePromise = null;

/** @param {{ stripe_publishable_key?: string } | null | undefined} account */
export function getStripePromise(account) {
  const key = stripePublishableKey(account);
  if (!key) return null;
  if (!stripePromise) {
    stripePromise = loadStripe(key);
  }
  return stripePromise;
}
