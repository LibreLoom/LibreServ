import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import App from "./App.jsx";

const authState = vi.hoisted(() => ({
  ready: true,
  isAuthenticated: false,
  me: null,
}));

vi.mock("./context/AuthContext.jsx", () => ({
  useAuth: () => ({
    ready: authState.ready,
    isAuthenticated: authState.isAuthenticated,
    me: authState.me,
    refreshMe: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("./context/AdminAuthContext.jsx", () => ({
  useAdminAuth: () => ({
    ready: true,
    isAuthenticated: false,
  }),
}));

vi.mock("./pages/Login.jsx", () => ({
  default: () => <div>Login page</div>,
}));

vi.mock("./pages/LunaPage.jsx", () => ({
  default: () => <div>Dashboard page</div>,
}));

vi.mock("./pages/OnboardingPage.jsx", () => ({
  default: () => <div>Onboarding page</div>,
}));

vi.mock("./pages/VerifyEmail.jsx", () => ({
  default: () => <div>Verify email page</div>,
}));

vi.mock("./pages/BackupsPage.jsx", () => ({
  default: () => <div>Backups page</div>,
  BackupsTab: () => null,
}));

vi.mock("./pages/AdminLogin.jsx", () => ({
  default: () => <div>Admin login</div>,
}));

vi.mock("./pages/AdminDashboardPage.jsx", () => ({
  default: () => <div>Admin dashboard</div>,
}));

vi.mock("./pages/AdminTokensPage.jsx", () => ({
  default: () => <div>Admin tokens</div>,
}));

vi.mock("./pages/AdminAccountsPage.jsx", () => ({
  default: () => <div>Admin accounts</div>,
}));

vi.mock("./pages/AdminSecurityPage.jsx", () => ({
  default: () => <div>Admin security</div>,
}));

vi.mock("./pages/AdminProvidersPage.jsx", () => ({
  default: () => <div>Admin providers</div>,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function mount(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("App root routing", () => {
  beforeEach(() => {
    authState.ready = true;
    authState.isAuthenticated = false;
    authState.me = null;
  });

  it("redirects / to /login when logged out", async () => {
    mount("/");
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/login");
    });
    expect(screen.getByText("Login page")).toBeTruthy();
    expect(screen.queryByText("Onboarding page")).toBeNull();
  });

  it("shows the dashboard at / when logged in", async () => {
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: true };
    mount("/");
    expect(await screen.findByText("Dashboard page")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(screen.queryByText("Onboarding page")).toBeNull();
  });

  it("shows the dashboard at / when logged in even if email is unverified", async () => {
    authState.isAuthenticated = true;
    authState.me = { email: "owner@example.com", email_verified: false };
    mount("/");
    expect(await screen.findByText("Dashboard page")).toBeTruthy();
    expect(screen.queryByText("Onboarding page")).toBeNull();
    expect(screen.queryByText("Login page")).toBeNull();
  });
});

describe("App", () => {
  it("exports BackupsTab from BackupsPage", async () => {
    const mod = await import("./pages/BackupsPage.jsx");
    expect(mod.BackupsTab).toBeTruthy();
  });
});
