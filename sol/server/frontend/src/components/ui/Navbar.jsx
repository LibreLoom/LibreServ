import { Grid2X2, Home, Settings, Users } from "lucide-react";
import SharedNavbar from "@libreloom/ui/components/ui/Navbar.jsx";
import { useAuth } from "../../hooks/useAuth";

const navItems = [
  { to: "/", icon: Home, label: "Dashboard", end: true },
  { to: "/apps", icon: Grid2X2, label: "Apps" },
  { to: "/users", icon: Users, label: "Users" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export default function Navbar() {
  const { me: user, logout } = useAuth();
  const isAdmin = user?.role === "admin";
  const menuItems = [
    { to: "/users", icon: Users, label: "Manage users", adminOnly: true },
    { to: isAdmin ? `/users/${user?.id || ""}` : "/users", icon: Settings, label: "Manage profile" },
  ];
  return (
    <SharedNavbar
      brand="LibreServ"
      items={navItems}
      user={user}
      onLogout={logout}
      menuItems={menuItems}
      storageKey="hamburgerPosition"
    />
  );
}
