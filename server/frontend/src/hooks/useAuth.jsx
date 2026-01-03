import { useContext } from "react";
import { AuthContext } from "../context/AuthContextContext";
export function useAuth() {
  // Centralize auth access so components don't touch context directly.
  const context = useContext(AuthContext);
  if (!context) {
    // Fail fast to keep null-context bugs obvious during development.
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
