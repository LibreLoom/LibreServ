import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Separator } from "./ui/separator.jsx";
import { LayoutDashboard, CreditCard, ChartBar, Package, Shield, LogOut, Sun, Moon, Plus } from "lucide-react";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/plans", label: "Plans", icon: Package },
  { to: "/usage", label: "Usage", icon: ChartBar },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/security", label: "Security", icon: Shield },
];

export function Layout({ children }) {
  const { logout, account } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkToken, setLinkToken] = useState("");

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-64 flex-col border-r border-border bg-card">
        <div className="flex h-16 items-center gap-2 px-6">
          <div className="h-8 w-8 rounded-pill bg-primary" />
          <span className="font-mono text-lg">Connect</span>
        </div>
        <Separator />
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
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
              <p className="font-mono text-xs text-muted-foreground">{account.email}</p>
              {account.has_2fa && <p className="font-mono text-xs text-success">2FA enabled</p>}
            </div>
          )}
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={toggle}>
            <Sun className="h-4 w-4 dark:hidden" />
            <Moon className="h-4 w-4 hidden dark:block" />
            Toggle Theme
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </aside>

      <main className="flex-1 ml-64 p-8 animate-fade-in">
        <div className="mx-auto max-w-5xl">
          {children}
        </div>
      </main>
    </div>
  );
}
