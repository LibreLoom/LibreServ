/* eslint-disable react-refresh/only-export-components */
import { render } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { AuthContext } from "../context/AuthContextContext";

function Wrapper({ children, authOverrides }) {
  const authValue = {
    me: null,
    csrfToken: null,
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    request: () => Promise.resolve(),
    initialized: true,
    ...authOverrides,
  };

  return (
    <BrowserRouter>
      <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
    </BrowserRouter>
  );
}

export function renderWithProviders(ui, { authOverrides, ...options } = {}) {
  return render(ui, {
    wrapper: (props) => <Wrapper {...props} authOverrides={authOverrides} />,
    ...options,
  });
}
