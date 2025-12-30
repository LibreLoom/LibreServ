{
  /*
========================================
LOGIN PAGE — PRODUCTION READINESS CHECKLIST
========================================

🟥 MUST-FIX (before shipping)
[X] Convert floating labels to real <label> elements
    - Labels always exist
    - Bound to inputs (htmlFor / id)
    - Animated via state, not conditional rendering

[X] Choose explicit success behavior
    - Hard reload OR client-side redirect
    - Must happen immediately on successful login

[X] Ensure success path terminates control flow
    - No late error rendering after success
    - No state updates after redirect/reload

[X] Remove all credential logging
    - No usernames
    - No passwords
    - No debug leftovers


🟧 STRONGLY RECOMMENDED (UX & accessibility)
[X] Errors are announced semantically
    - Error container marked as important
    - Screen readers notice login failure

[ ] Loading state is communicated non-visually
    - Not just button text
    - Form indicates “busy”

[ ] Only submit is locked during loading
    - Inputs remain editable
    - Button disabled while request is in flight

[ ] Retry is frictionless
    - Immediate retry after failure
    - No forced resets
    - No surprise cooldowns (except 429)


🟨 NICE-TO-HAVE POLISH
[ ] Refine error copy
    - Calm, human language
    - No protocol jargon unless helpful

[ ] Gate MDN / status-code link
    - Show only for unknown or 5xx errors
    - Hide for common auth failures (401)

[ ] Normalize field metadata
    - name="username"
    - name="password"
    - Consistent casing for password managers

[ ] Optional UI helpers
    - <FormError />
    - <SubmitButton />


🟩 OPTIONAL HARDENING (advanced)
[ ] Handle offline / network failure gracefully
[ ] Cooldown logic after 429
[ ] Focus error message on failure
[ ] Subtle success transition


🚦 SHIP CHECK (all must be true)
[ ] One submit = one login attempt
[ ] Inputs editable during request
[ ] Button locked during request
[ ] Errors clear on retry
[ ] Success path is explicit
[ ] Labels work with keyboard & screen readers

========================================
*/
}
import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null);
  const [error, setError] = useState(null);

  const { login } = useAuth();
  function calculateErrorHTML() {
    if (error) {
      return error;
    } else if (errorStatus) {
      return (
        <p>
          Login failed. Something might be misconfigured. See
          <a
            href={
              "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/" +
              errorStatus
            }
            className="underline"
          >
            {" this page "}
          </a>
          for info that might be helpful.
        </p>
      );
    }
  }
  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password || loading) return;
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    try {
      await login(username, password);
      window.location.reload();
    } catch (error) {
      if (error.cause?.status === 401) {
        setError("Login failed: Invalid username or password.");
      } else if (error.cause?.status === 429) {
        setError("Login failed: Please wait a bit before trying again.");
      } else {
        setErrorStatus(error.cause?.status);
      }
      setLoading(false);
    }
  }
  return (
    <main className="fixed inset-0 grid place-items-center bg-primary">
      <div className="relative w-full max-w-lg overflow-scroll bg-secondary text-primary rounded-large-element outline-2 outline-accent pop-in p-8">
        <span className="text-primary font-mono text-2xl">LibreServ</span>
        <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
        <span className="text-primary font-mono text-xl font-weight-400">
          Hey there! Log in to continue.
        </span>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col mt-6 rounded-large-element border-2 border-accent p-4 bg-primary text-secondary"
        >
          <label
            htmlFor="username"
            className={`text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1`}
          >
            Username
          </label>
          <input
            value={username}
            placeholder="e.g. admin"
            id="username"
            onChange={(e) => setUsername(e.target.value)}
            className="placeholder:text-accent border-2 border-secondary rounded-pill p-2 mb-4"
            name="Username"
            autoComplete="username"
          ></input>
          <label
            htmlFor="password"
            className={`text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1`}
          >
            Password
          </label>
          <input
            value={password}
            placeholder="e.g. hunter2"
            id="password"
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            className="placeholder:text-accent border-2 border-secondary rounded-pill p-2"
            name="Password"
            autoComplete="current-password"
          ></input>
          <button
            className={`bg-secondary text-primary rounded-pill p-2 ${loading ? "opacity-50" : ""} mt-6`}
            disabled={loading}
          >
            {loading ? "Loading..." : "Login"}
          </button>
          <div
            className={`text-accent ${errorStatus || error ? "mt-4" : ""}`}
            role="alert"
            aria-live="assertive"
          >
            {(error || errorStatus) && calculateErrorHTML()}
          </div>
        </form>
      </div>
    </main>
  );
}
