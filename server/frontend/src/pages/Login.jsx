import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { login } = useAuth();
  return (
    <main>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await login(username, password);
            navigate("/");
          } catch (err) {
            console.error("Login failed:", err);
            setError("Login failed. Check your username and password.");
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
          {error ? <p>{error}</p> : null}
        </div>
      </form>
    </main>
  );
}
