/* eslint-disable react-refresh/only-export-components */
import { render } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "../context/AuthContextContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

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
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}

/**
 * @param {any} ui
 * @param {{ authOverrides?: any, [key: string]: any }} [options]
 */
export function renderWithProviders(ui, { authOverrides, ...options } = {}) {
  return render(ui, {
    wrapper: (props) => <Wrapper {...props} authOverrides={authOverrides} />,
    ...options,
  });
}
