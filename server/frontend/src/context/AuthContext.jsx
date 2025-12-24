// TODO: Implement AuthContext
import { createContext } from "react";
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  return <AuthContext.Provider value={null}>{children}</AuthContext.Provider>;
}
