import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [errorStatus, setErrorStatus] = useState(null);
  const { login } = useAuth();
  return (
    <main className="fixed inset-0 grid place-items-center">
      <form
        className="flex flex-col"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            setErrorStatus(null);
            setError(null);
            await login(username, password);
            window.location.reload();
          } catch (err) {
            console.error("Login failed:", err);
            if (err.cause?.status === 401) {
              setError("Login failed. Check your username and password.");
            } else if (err.cause?.status === 429) {
              setError(
                "Login failed. Please wait a bit prior to trying again!",
              );
            } else {
              setErrorStatus(err.cause?.status);
            }
          }
        }}
      >
        <div>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
          />
          <button type="submit">Login</button>
          {error ? <p className="text-secondary">{error}</p> : null}{" "}
          {errorStatus ? (
            <p className="text-secondary">
              See{" "}
              <a
                className="underline text-accent"
                href={`https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/${errorStatus}`}
              >
                this page
              </a>{" "}
              for details that'll probably be helpful.
            </p>
          ) : null}
        </div>
      </form>
    </main>
  );
}
