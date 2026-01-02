import { User, Mail, Shield, Calendar } from "lucide-react";
import CardButton from "./CardButton";

/**
 * UserCard - Displays user information including username, email, role, and creation date
 */
export default function UserCard({
  id,
  username,
  email,
  role,
  createdAt,
  onManage,
  onDelete,
}) {
  // Format the creation date
  const formatDate = (dateString) => {
    if (!dateString) return "Unknown";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  // Determine role badge color
  const roleColor = role === "admin" ? "text-accent" : "text-primary";

  return (
    <div className="pop-in flex-1 m-1.25 bg-secondary text-primary rounded-3xl p-5 motion-safe:transition hover:scale-[1.02] self-start">
      {/* Header with user icon and username */}
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <User size={22} aria-hidden="true" />
        </div>
        <div className="text-left">
          <div className="font-semibold">{username}</div>
        </div>
      </div>

      {/* Divider */}
      <div className="h-1 bg-primary rounded-pill mx-1 my-4" />

      {/* User details */}
      <div className="text-left space-y-2">
        {/* Email */}
        <div className="flex items-center gap-2 text-sm">
          <Mail size={14} className="text-accent" aria-hidden="true" />
          <span className="text-accent">{email}</span>
        </div>

        {/* Role */}
        <div className="flex items-center gap-2 text-sm">
          <Shield size={14} className={roleColor} aria-hidden="true" />
          <span className={roleColor}>
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </span>
        </div>

        {/* Created date */}
        <div className="flex items-center gap-2 text-sm">
          <Calendar size={14} className="text-accent" aria-hidden="true" />
          <span className="text-accent">
            Created: {formatDate(createdAt)}
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-4 space-y-2">
        {onManage && (
          <CardButton action={() => onManage(id)} actionLabel="Manage" />
        )}
        {onDelete && (
          <button
            onClick={() => onDelete(id)}
            className="w-full px-4 py-2 bg-primary text-secondary rounded-pill hover:opacity-80 transition-opacity text-sm font-medium"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
