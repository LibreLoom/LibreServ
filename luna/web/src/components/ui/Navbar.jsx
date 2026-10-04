import {
  HardDrive,
  Home,
  Image as ImageIcon,
  Laptop,
  Palette,
  Shield,
  Share2,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import SharedNavbar from "@libreloom/ui/components/ui/Navbar.jsx";
import { useAuth } from "../../context/AuthContext";

const navItems = [
  { to: "/", icon: Home, label: "Home", end: true },
  { to: "/gallery", icon: ImageIcon, label: "Photos" },
  { to: "/drives", icon: HardDrive, label: "Files" },
  { to: "/shared", icon: Share2, label: "Shared" },
  { to: "/settings/users", icon: Users, label: "Users", adminOnly: true },
  { to: "/settings", icon: SlidersHorizontal, label: "Settings", end: true },
];

// Shortcuts into Settings, so your own account is one hover away.
const menuItems = [
  { to: "/settings#security", icon: Shield, label: "Security" },
  { to: "/settings#devices", icon: Laptop, label: "Devices" },
  { to: "/settings#appearance", icon: Palette, label: "Appearance" },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  return (
    <SharedNavbar
      brand="Luna"
      items={navItems}
      user={user}
      onLogout={logout}
      menuItems={menuItems}
      storageKey="lunaHamburgerPosition"
      editorKey="lunaEditor"
      showShortcutsHint={false}
    />
  );
}
