import { useRef, useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null);
  const errorRef = useRef(null);
  const { login } = useAuth();
  useEffect(() => {
    if (errorStatus && errorRef.current) {
      errorRef.current.focus();
    }
  }, [errorStatus]);

  function calculateErrorHTML() {
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
        <span className="text-primary font-mono text-2xl">LibreServ</span>
        <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
        <span className="text-primary font-mono text-xl font-weight-400">
          Hey there! Log in to continue.
        </span>
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
