import {
  FolderOpen,
  HardDrive,
  Home,
  Image as ImageIcon,
  Share2,
  SlidersHorizontal,
  UserRound,
  Users,
} from "lucide-react";
import SharedNavbar from "@libreloom/ui/components/ui/Navbar.jsx";
import { useAuth } from "../../context/AuthContext";
import { useFilesNavGrouped } from "../../hooks/useFilesNavGrouped.js";

const flatNavItems = [
  { to: "/", icon: Home, label: "Home", end: true },
  { to: "/gallery", icon: ImageIcon, label: "Photos" },
  { to: "/drives", icon: HardDrive, label: "Files" },
  { to: "/shared", icon: Share2, label: "Shared" },
  { to: "/settings/users", icon: Users, label: "Users", adminOnly: true },
  { to: "/settings", icon: SlidersHorizontal, label: "Settings", end: true },
];

const groupedNavItems = [
  { to: "/", icon: Home, label: "Home", end: true },
  {
    key: "files",
    icon: FolderOpen,
    label: "Files",
    storageKey: "navGroup:files",
    children: [
      { to: "/drives", icon: HardDrive, label: "Drives" },
      { to: "/shared", icon: Share2, label: "Shared" },
      { to: "/gallery", icon: ImageIcon, label: "Photos", match: ["/gallery", "/photos"] },
    ],
  },
  { to: "/settings/users", icon: Users, label: "Users", adminOnly: true },
  { to: "/settings", icon: SlidersHorizontal, label: "Settings", end: true },
];

const menuItems = [{ to: "/settings#security", icon: UserRound, label: "You" }];

export default function Navbar() {
  const { user, logout } = useAuth();
  const [filesGrouped] = useFilesNavGrouped();
  return (
    <SharedNavbar
      brand="Luna"
      items={filesGrouped ? groupedNavItems : flatNavItems}
      user={user}
      onLogout={logout}
      menuItems={menuItems}
      storageKey="lunaHamburgerPosition"
      editorKey="lunaEditor"
      showShortcutsHint={false}
    />
  );
}
