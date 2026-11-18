import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api.js";

/**
 * Payments happen on a Stripe-hosted page (Stripe sells through Link and adds
 * any sales tax or VAT). Stripe then sends the browser back to `returnTo` with
 * `?checkout=<session id>`, where useCheckoutReturn finishes the checkout.
 */

/** Where people update the card for cloud backup (Stripe sells it through Link). */
export const LINK_MANAGE_URL = "https://app.link.com";

/**
 * @typedef {"card_check" | "backup"} CheckoutKind
 * @typedef {"onboarding" | "diyonboarding" | "backups"} CheckoutReturn
 */

/**
 * Opens the Stripe payment page. Resolves `{ done: true }` when there is nothing
 * to pay (already paid, or a local test setup without Stripe); otherwise the
 * browser is leaving for Stripe.
 * @param {CheckoutKind} kind
 * @param {CheckoutReturn} returnTo
 * @returns {Promise<{ done?: boolean, checkout_url?: string }>}
 */
export async function startCheckout(kind, returnTo) {
  const res = await api("/api/v1/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ kind, return_to: returnTo }),
  });
  if (res?.checkout_url) window.location.assign(res.checkout_url);
  return res || {};
}

const RETRY_MS = 3000;
const MAX_TRIES = 20;

/**
 * Finishes a checkout when Stripe sends the browser back with ?checkout=…, then
 * calls onDone(kind) once. Some payment methods take a moment, so it asks again
 * for about a minute before giving up.
 * @param {(kind: string) => unknown} onDone
 * @returns {{ status: "idle" | "checking" | "error", error: string }}
 */
export function useCheckoutReturn(onDone) {
  const location = useLocation();
  const navigate = useNavigate();
  const sessionId = new URLSearchParams(location.search).get("checkout") || "";
  const [status, setStatus] = useState(/** @type {"idle" | "checking" | "error"} */ (sessionId ? "checking" : "idle"));
  const [error, setError] = useState("");
  const handled = useRef("");
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!sessionId || handled.current === sessionId) return undefined;
    handled.current = sessionId;
    let stopped = false;
    let timer;
    setStatus("checking");
    setError("");

    const clearParam = () => {
      const params = new URLSearchParams(location.search);
      params.delete("checkout");
      const search = params.toString();
      navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
    };

    const attempt = async (tries) => {
      try {
        const res = await api("/api/v1/billing/checkout/complete", {
          method: "POST",
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (stopped) return;
        if (res?.done) {
          clearParam();
          setStatus("idle");
          await onDoneRef.current?.(res.kind || "");
          return;
        }
        if (tries + 1 >= MAX_TRIES) {
          setStatus("error");
          setError("Stripe hasn't confirmed the payment yet. Reload this page in a few minutes.");
          return;
        }
        timer = setTimeout(() => attempt(tries + 1), RETRY_MS);
      } catch (err) {
        if (stopped) return;
        // A server error (Stripe busy, the webhook finishing the same payment
        // at the same moment) is worth asking again; a refusal is not.
        if ((err?.status || 0) >= 500 && tries + 1 < MAX_TRIES) {
          timer = setTimeout(() => attempt(tries + 1), RETRY_MS);
          return;
        }
        setStatus("error");
        setError(err?.message || "Could not check that payment. Reload this page in a minute.");
      }
    };
    attempt(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { status, error };
}
