import { User, Mail, Shield, Calendar } from "lucide-react";
import BaseCard from "./BaseCard";
import Button from "../ui/Button";
import { formatDateOnly } from "../../lib/time-utils.js";

export default function UserCard({
  id,
  username,
  email,
  role,
  createdAt,
  onDelete,
}) {
  const roleColor = role === "admin" ? "text-accent" : "text-primary";

  return (
    <BaseCard icon={User} title={username}>
      <div className="text-left space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Mail size={14} className="text-accent" aria-hidden="true" />
          <span className="text-accent">{email}</span>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Shield size={14} className={roleColor} aria-hidden="true" />
          <span className={roleColor}>
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </span>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Calendar size={14} className="text-accent" aria-hidden="true" />
          <span className="text-accent">Created: {formatDateOnly(createdAt)}</span>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <Button variant="secondary" className="w-full" onClick={() => window.location.href = `/users/${id}`}>
          Manage
        </Button>
        {onDelete && (
          <Button variant="danger" className="w-full" onClick={() => onDelete(id)}>
            Delete
          </Button>
        )}
      </div>
    </BaseCard>
  );
}
