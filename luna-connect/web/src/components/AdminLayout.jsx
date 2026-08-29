import { NavLink, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../context/AdminAuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "./ui/button.jsx";
import { Separator } from "./ui/separator.jsx";
import {
  LayoutDashboard,
  Server,
  KeyRound,
  Users,
  Shield,
  Cloud,
  LogOut,
  Sun,
  Moon,
} from "lucide-react";

const navItems = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/admin/devices", label: "Devices", icon: Server },
  { to: "/admin/tokens", label: "Setup codes", icon: KeyRound },
  { to: "/admin/accounts", label: "Accounts", icon: Users },
  { to: "/admin/providers", label: "Connections", icon: Cloud },
  { to: "/admin/security", label: "Security", icon: Shield },
];

export function AdminLayout({ children }) {
  const { logout, account } = useAdminAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const prefersDark =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);
  const brandSrc = isDark ? "/favicon-dark.svg" : "/favicon.svg";

  return (
    <div className="flex min-h-screen bg-background text-foreground" data-testid="admin-layout">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-64 flex-col border-r border-border bg-card">
        <div className="flex h-16 items-center gap-2.5 px-6">
          <img src={brandSrc} alt="" className="size-8 shrink-0" width={32} height={32} />
          <span className="flex h-8 items-center font-mono text-lg leading-none">Admin</span>
        </div>
        <Separator />
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-pill px-4 py-2.5 font-mono text-sm transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <Separator />
        <div className="p-3 space-y-2">
          {account && (
            <div className="px-4 py-2">
              <p className="font-mono text-xs text-muted-foreground">{account.email || "Staff"}</p>
              {account.has_2fa && <p className="font-mono text-xs text-success">2FA enabled</p>}
            </div>
          )}
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={toggle}>
            <Sun className="h-4 w-4 dark:hidden" />
            <Moon className="h-4 w-4 hidden dark:block" />
            Toggle Theme
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
            onClick={async () => {
              await logout();
              navigate("/admin/login");
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </aside>
      <main className="flex-1 ml-64 p-8 animate-fade-in">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
