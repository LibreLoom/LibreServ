import { cn } from "../../lib/utils.js";
import { Link } from "react-router-dom";
import { User, Shield, ChevronRight } from "lucide-react";
import { InfoHint } from "../../components/ui/Tooltip.jsx";
import { ICON_SIZE } from "../../lib/ui-tokens.js";

/**
 * Signed-in user summary at the top of the settings sidebar.
 *
 * @param {{ user: object|null, href?: string|((user: object) => string|null), deviceName?: string }} props
 *   href — link target for the card. Pass a string or a function of `user`
 *   (e.g. link admins only: `u => u.role === "admin" ? "/settings/users" : null`).
 *   Omit or return null to render a plain div.
 *   deviceName — product noun used in the role hints ("this Luna", "this server").
 */
export default function SettingsUserCard({ user, href, deviceName = "this device" }) {
  if (!user) return null;

  const isAdmin = user.role === "admin";
  const to = typeof href === "function" ? href(user) : href;

  const body = (
    <>
      <div className="h-12 w-12 rounded-full bg-primary text-secondary flex items-center justify-center flex-shrink-0">
        <User size={ICON_SIZE.xl} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-primary truncate">{user.username}</div>
        <div className="text-sm text-primary flex items-center gap-1">
          <Shield size={ICON_SIZE.xs} />
          {isAdmin ? (
            <span className="inline-flex items-center gap-1">
              <span>Admin</span>
              <InfoHint
                label="What Admin means"
                content={`An Admin can add users, change settings, and manage everything on ${deviceName}.`}
              />
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span>Member</span>
              <InfoHint
                label="What Member means"
                content={`A Member can use what's shared with them but cannot manage users or change ${deviceName} settings.`}
              />
            </span>
          )}
        </div>
      </div>
      {to && (
        <ChevronRight
          size={ICON_SIZE.lg}
          className="text-accent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex-shrink-0"
        />
      )}
    </>
  );

  const classes = cn(
    "flex items-center gap-3 p-3 rounded-large-element bg-primary/10 hover:bg-primary/20 transition-all duration-200 group animate-in fade-in slide-in-from-left-1 duration-150",
    "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 no-focus-outline",
  );

  if (to) {
    return (
      <Link data-slot="settings-user-card" to={to} className={classes}>
        {body}
      </Link>
    );
  }

  return (
    <div data-slot="settings-user-card" className={classes}>
      {body}
    </div>
  );
}
