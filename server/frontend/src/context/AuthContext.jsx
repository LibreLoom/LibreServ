// TODO: Implement AuthContext
import { createContext } from "react";
const AuthContext = createContext(null);
export function AuthProvder({ children }) {
  return <AuthContext.Provider value={null}>{children}</AuthContext.Provider>;
}
