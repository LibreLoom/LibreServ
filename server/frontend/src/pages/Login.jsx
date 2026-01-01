import { useRef, useEffect, useState, useMemo } from "react";
import { useAuth } from "../hooks/useAuth";

const loginQuips = [
  "The pigeon checks the clipboard. You’re on the list.",
  "The pigeon adjusts the badge reader and nods approvingly.",
  "The mouse intern holds the door and whispers ‘they’re cool’.",
  "The pigeon says credentials first, then vibes.",
  "The seagull tried to sneak in earlier. The pigeon remains undefeated.",
  "The turtle from HR reminds everyone there’s no rush.",
  "The pigeon cleared this login space just for you.",
  "The clipboard says ‘expected’. The pigeon agrees.",
  "The mouse intern is watching respectfully.",
  "The pigeon believes this will go smoothly.",

  "The pigeon double-checks the door. It opens politely.",
  "The raccoon accountant confirms access is approved.",
  "The pigeon offers a calm, professional nod.",
  "The mouse intern practiced this moment.",
  "The pigeon says this is the right entrance.",
  "The seagull is not allowed past this point.",
  "The turtle from HR suggests a steady pace.",
  "The pigeon flips the sign from ‘closed’ to ‘welcoming’.",
  "The clipboard is ready when you are.",
  "The pigeon has prepared a dignified silence.",

  "The pigeon recognizes you immediately.",
  "The mouse intern beams. This is exciting.",
  "The pigeon checks once. Then once more. All good.",
  "The raccoon accountant approves the numbers involved.",
  "The pigeon says you’re right on time.",
  "The turtle from HR nods slowly but meaningfully.",
  "The pigeon straightens the entry sign.",
  "The mouse intern whispers encouragement professionally.",
  "The pigeon considers this a routine success.",
  "The clipboard has no objections today.",

  "The pigeon gently gestures toward the login fields.",
  "The mouse intern labels this ‘a big moment’.",
  "The pigeon confirms this is the correct doorway.",
  "The seagull is watching from outside. Jealous.",
  "The turtle from HR says everyone belongs here calmly.",
  "The pigeon checks credentials with care and trust.",
  "The raccoon accountant notes this as ‘authorized’.",
  "The pigeon says access looks good from here.",
  "The mouse intern adjusts their tiny badge.",
  "The pigeon opens the door metaphorically.",

  "The pigeon is pleased to see you return.",
  "The clipboard says this is familiar territory.",
  "The mouse intern waves, then remembers professionalism.",
  "The pigeon verifies calmly, without judgment.",
  "The turtle from HR approves the tone of this moment.",
  "The pigeon marks this as a safe entry point.",
  "The raccoon accountant says everything checks out.",
  "The pigeon believes you belong on the other side of this door.",
  "The mouse intern learned about logins yesterday.",
  "The pigeon is ready when you are.",
];

function getLoginQuip() {
  const hoursSinceEpoch = Math.floor(Date.now() / 43200000);
  return loginQuips[hoursSinceEpoch % loginQuips.length];
}

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null);
  const errorRef = useRef(null);
  const { login } = useAuth();
  const loginQuip = useMemo(() => getLoginQuip(), []);
  useEffect(() => {
    if (errorStatus && errorRef.current) {
      // Move focus to the error copy for screen readers/keyboard users.
      errorRef.current.focus();
    }
  }, [errorStatus]);

  function calculateErrorHTML() {
    // Translate backend status codes into friendly guidance.
    if (errorStatus === 401) {
      return (
        <p>
          It seems that your username or password might be incorrect.
          Double-check to make sure they're right!
        </p>
      );
    } else if (errorStatus === 429) {
      return (
        <p>
          Please wait a bit before trying again. If you can't remember your
          password, feel free to contact support!
        </p>
      );
    } else if (errorStatus === 500) {
      return (
        <p>
          Wait up! If you just rebooted, updated, or simply turned on your
          LibreServ, it may still be starting up. <br />
          <br />
          If this issue has been happening repeatedly, try rebooting your
          LibreServ (it's not super intuitive for this error, but trust us, it
          can help). <br />
          <br /> If you've rebooted your LibreServ and continue encountering
          this issue, try contacting support for assistance.
        </p>
      );
    } else if (errorStatus == "NetworkError") {
      return (
        <p>
          Check your device's connection to the internet. (Not your LibreServ's,
          but this device's!) <br />
          <br />
          If you're absolutely sure that you are connected to the internet,
          please try rebooting your LibreServ. <br />
          <br />
          If you've both rebooted your LibreServ and have ensured that your
          device is connected to the internet, please reach out to support for
          assistance.{" "}
        </p>
      );
    } else if (errorStatus) {
      return (
        <p>
          We've encountered an unidentified error while trying to log in.
          <br />
          <br />
          If you're having this issue repeatedly, start by rebooting your
          LibreServ. If that fails, feel free to contact support to help resolve
          this issue, we're always happy to help! <br />
          <br />
          See
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
    setErrorStatus(null);
    try {
      await login(username, password);
      // Reload to re-run auth bootstrap and reset any stale state.
      window.location.reload();
    } catch (errorStatus) {
      if (!errorStatus.cause?.status) {
        setErrorStatus("NetworkError");
      } else {
        setErrorStatus(errorStatus.cause?.status);
      }
      setLoading(false);
    }
  }
  return (
    <main className="fixed inset-0 grid place-items-center bg-primary">
      <div className="relative w-full max-w-lg overflow-scroll bg-secondary text-primary rounded-large-element outline-2 outline-accent pop-in p-8">
        <span className="text-primary font-mono text-2xl block text-center">
          LibreServ
        </span>
        <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
        <span className="text-primary font-sans text-xl font-bold block text-center">
          Hey there! Log in to continue.
        </span>
        <p className="text-accent text-sm text-center mt-2">{loginQuip}</p>
        <form
          onSubmit={handleSubmit}
          aria-busy={loading}
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
            name="username"
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
            name="password"
            autoComplete="current-password"
          ></input>
          <button
            className={`bg-secondary text-primary rounded-pill p-2 ${loading ? "opacity-50" : ""} mt-6`}
            disabled={loading}
          >
            {loading ? "Loading..." : "Login"}
          </button>
          <div
            className={`text-accent ${errorStatus ? "mt-4" : ""}`}
            role="alert"
            aria-live="assertive"
            ref={errorRef}
            tabIndex={-1}
          >
            {errorStatus && calculateErrorHTML()}
          </div>
        </form>
      </div>
    </main>
  );
}
