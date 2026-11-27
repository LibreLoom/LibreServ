import {
  HardDrive,
  Home,
  Image as ImageIcon,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import Share from "@libreloom/ui/components/common/ShareIcon.jsx";
import SharedNavbar from "@libreloom/ui/components/ui/Navbar.jsx";
import { useAuth } from "../../context/AuthContext";

const navItems = [
  { to: "/", icon: Home, label: "Home", end: true },
  { to: "/photos", icon: ImageIcon, label: "Photos" },
  { to: "/files", icon: HardDrive, label: "Files" },
  { to: "/shared", icon: Share, label: "Shared" },
  { to: "/settings", icon: SlidersHorizontal, label: "Settings", end: true },
];

const menuItems = [{ to: "/settings#security", icon: UserRound, label: "You" }];

/** @param {{ onNavigationIntent?: (to: string) => void }} props */
export default function Navbar({ onNavigationIntent }) {
  const { user, logout } = useAuth();
  return (
    <SharedNavbar
      brand="Luna"
      items={navItems}
      user={user}
      onLogout={logout}
      onNavigationIntent={onNavigationIntent}
      menuItems={menuItems}
      storageKey="lunaHamburgerPosition"
      editorKey="lunaEditor"
      showShortcutsHint={false}
    />
  );
}
