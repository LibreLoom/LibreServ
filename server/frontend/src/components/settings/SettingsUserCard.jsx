import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { User, Shield, ChevronRight } from "lucide-react";

export default function SettingsUserCard({ user }) {
  if (!user) return null;

  return (
    <Link
      data-slot="settings-user-card"
      to={`/users/${user.id}`}
      className={cn(
        "flex items-center gap-3 p-3 rounded-large-element bg-primary/10 hover:bg-primary/20 transition-all duration-200 group animate-in fade-in slide-in-from-left-1 duration-150",
        "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 no-focus-outline"
      )}
    >
      <div className="h-12 w-12 rounded-full bg-primary text-secondary flex items-center justify-center flex-shrink-0">
        <User size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-primary truncate">{user.username}</div>
        <div className="text-sm text-primary flex items-center gap-1">
          <Shield size={12} />
          <span className="capitalize">{user.role}</span>
        </div>
      </div>
      <ChevronRight
        size={18}
        className="text-accent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex-shrink-0"
      />
    </Link>
  );
}
