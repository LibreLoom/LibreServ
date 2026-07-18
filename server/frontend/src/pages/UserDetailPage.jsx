import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import Card from "../components/cards/Card";
import MetricCard from "../components/cards/MetricCard";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import ValueDisplay from "../components/common/ValueDisplay";
import ConfirmModal from "../components/cards/ConfirmModal";
import ModalCard from "../components/cards/ModalCard";
import ObjectNotFound from "./ObjectNotFound";
import StateOverlay from "../components/cards/StateOverlay";
import Page from "../components/ui/Page";
import api from "../lib/api";
import { User, Shield, KeyRound, Pencil, Trash2 } from "lucide-react";
import ChangeEmailForm from "../components/common/forms/ChangeEmailForm";
import RoleChangeForm from "../components/common/forms/RoleChangeForm";
import SetPasswordForm from "../components/common/forms/SetPasswordForm";
import { useAuth } from "../hooks/useAuth";
import { useTimeFormat } from "../hooks/useTimeFormat";

// Whole days between a timestamp and now. null when the timestamp is missing.
// ponytail: tiny local helper — only this page needs relative-day math right now;
// promote to time-utils if a second caller appears.
function daysSince(dateString) {
  if (!dateString) return null;
  return Math.floor((Date.now() - new Date(dateString).getTime()) / 86400000);
}

// Complete class strings — Tailwind's JIT only emits classes it can see as
// literals, so dynamic `text-${variant}` would silently produce no color.
const TIER_TEXT = {
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  muted: "text-accent",
};

// At-a-glance login health, derived purely from last_login. Maps to the same
// token-based status colors the rest of the app uses (success/warning/error/muted).
function activityTier(daysSinceLogin) {
  if (daysSinceLogin === null) return { label: "Never", variant: "muted" };
  if (daysSinceLogin <= 7) return { label: "Active", variant: "success" };
  if (daysSinceLogin <= 30) return { label: "Recent", variant: "warning" };
  return { label: "Dormant", variant: "error" };
}

// "X days ago" / "Today" / "Never" — humanised relative time for stat tiles.
function relativeLabel(days) {
  if (days === null) return "Never";
  if (days < 1) return "Today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function UserDetailPage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { formatDateLong } = useTimeFormat();
  const { me } = useAuth();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [showSetPasswordModal, setShowSetPasswordModal] = useState(false);

  useEffect(() => {
    let delayTimer;
    const fetchUser = async () => {
      try {
        delayTimer = setTimeout(() => {
          setShowLoading(true);
        }, 500);
        setError(null);
        setNotFound(false);
        const response = await api(`/users/${userId}`);
        const userData = await response.json();
        setUser(userData);
      } catch (err) {
        const status = err?.cause?.status;
        if (status === 404) {
          setUser(null);
          setNotFound(true);
          return;
        }
        setError(err.message);
      } finally {
        clearTimeout(delayTimer);
        setShowLoading(false);
        setLoading(false);
      }
    };
    fetchUser();
    return () => clearTimeout(delayTimer);
  }, [userId]);

  const handleDeleteUser = async () => {
    try {
      const csrfResponse = await api("/auth/csrf");
      const csrfData = await csrfResponse.json();

      await api(`/users/${userId}`, {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": csrfData.csrf_token,
        },
      });

      navigate("/users");
    } catch (err) {
      const message = err?.message || "Unable to delete user. Please try again.";
      if (message.includes("last admin") || message.includes("last admin user")) {
        alert("Cannot delete the last admin user. There must be at least one admin.");
      } else {
        alert(message);
      }
    }
  };

  const handleEditSuccess = (newEmail) => {
    setUser((prev) => ({ ...prev, email: newEmail }));
    setShowEditModal(false);
  };

  const handleRoleChangeSuccess = (newRole) => {
    setUser((prev) => ({ ...prev, role: newRole }));
    setShowRoleModal(false);
  };

  const handleSetPasswordSuccess = () => {
    setShowSetPasswordModal(false);
  };

  const formatDate = (dateString) => {
    if (!dateString) return "Unknown";
    return formatDateLong(dateString);
  };

  if (!loading && (notFound || (!error && !user))) {
    return (
      <ObjectNotFound
        objectLabel="user"
        objectName={userId}
        backTo="/users"
        backLabel="Users"
        backIcon={User}
      />
    );
  }

  // Derived stats — all computable from the fields the API already returns
  // (created_at / updated_at / last_login). No new backend work needed.
  const ageDays = user ? daysSince(user.created_at) : null;
  const loginDays = user?.last_login ? daysSince(user.last_login) : null;
  const modDays = user ? daysSince(user.updated_at) : null;
  const tier = activityTier(loginDays);
  // An admin must not change their own role or delete their own account —
  // both are backend-enforced (403), and hidden here too. Password can always
  // be set (admins may set their own password directly).
  const isSelf = Boolean(me?.id && user && me.id === user.id);

  return (
    <Page
      data-slot="user-detail"
      title={user?.username || user?.email || "User"}
      titleId="user-detail-title"
      leftContent={
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary text-secondary">
          <User size={22} className="text-secondary" aria-hidden />
        </span>
      }
      rightContent={
        user && (
          <span className="flex items-center gap-2">
            <Pill variant={user.role === "admin" ? "accent" : "default"}>
              <Shield size={12} className="mr-1" aria-hidden="true" />
              {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
            </Pill>
            <Pill variant={tier.variant}>{tier.label}</Pill>
          </span>
        )
      }
      headerClassName="mb-6"
    >
      {loading && showLoading && <StateOverlay message="Loading user..." />}

      {error && (
        <StateOverlay kind="error">
          <p>Error: {error}</p>
        </StateOverlay>
      )}

      {!loading && !error && user && (
        <>
          {/* At-a-glance derived stats — relative time since each key event. */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-label="User stats">
            <MetricCard label="Account Age" value={relativeLabel(ageDays)} />
            <MetricCard
              label="Since Login"
              value={relativeLabel(loginDays)}
              valueClassName={TIER_TEXT[tier.variant]}
            />
            <MetricCard label="Last Modified" value={relativeLabel(modDays)} />
          </section>

          {/* Profile details — dense label/value rows in a single card. */}
          <section className="mt-4" aria-label="Profile details">
            <Card padding={false}>
              <div className="px-5 pt-4 pb-2 flex items-center gap-2">
                <User size={18} className="text-accent" aria-hidden="true" />
                <h2 className="text-lg font-mono font-normal">Profile</h2>
              </div>
              <div className="px-5 pb-5 flex flex-col gap-2">
                <ValueDisplay label="Email" value={user.email} mono={false} />
                <ValueDisplay label="Account Created" value={formatDate(user.created_at)} />
                <ValueDisplay label="Last Updated" value={formatDate(user.updated_at)} />
                <ValueDisplay
                  label="Last Login"
                  value={user.last_login ? formatDate(user.last_login) : "Never"}
                />
                <ValueDisplay label="User ID" value={user.id} />
              </div>
            </Card>
          </section>

          {/* Actions — compact pill button row instead of full-width grid. */}
          <section className="mt-4" aria-label="User actions">
            <Card surface="primary">
              <div className="flex items-center gap-2 mb-3">
                <Shield size={18} className="text-accent" aria-hidden="true" />
                <h2 className="text-lg font-mono font-normal">Actions</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" surface="primary" onClick={() => setShowEditModal(true)}>
                  <Pencil size={14} aria-hidden="true" />
                  Change Email
                </Button>
                {!isSelf && (
                  <Button variant="outline" surface="primary" onClick={() => setShowRoleModal(true)}>
                    <Shield size={14} aria-hidden="true" />
                    Change Role
                  </Button>
                )}
                <Button
                  variant="accent"
                  surface="primary"
                  onClick={() => setShowSetPasswordModal(true)}
                >
                  <KeyRound size={14} aria-hidden="true" />
                  Set Password
                </Button>
                {!isSelf && (
                  <Button variant="danger" surface="primary" onClick={() => setShowDeleteConfirm(true)}>
                    <Trash2 size={14} aria-hidden="true" />
                    Delete User
                  </Button>
                )}
              </div>
            </Card>
          </section>
        </>
      )}

      <ConfirmModal
        open={showDeleteConfirm && !!user}
        title="Delete User"
        message={`Are you sure you want to delete user "${user?.username}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        icon={User}
        onConfirm={handleDeleteUser}
        onClose={() => setShowDeleteConfirm(false)}
      />

      {showEditModal && user && (
        <ModalCard title="Change Email" onClose={() => setShowEditModal(false)}>
          {({ close }) => (
            <ChangeEmailForm user={user} onSuccess={handleEditSuccess} onCancel={close} />
          )}
        </ModalCard>
      )}

      {showRoleModal && user && (
        <ModalCard title="Change Role" onClose={() => setShowRoleModal(false)}>
          {({ close }) => (
            <RoleChangeForm user={user} onSuccess={handleRoleChangeSuccess} onCancel={close} />
          )}
        </ModalCard>
      )}

      {showSetPasswordModal && user && (
        <ModalCard title="Set Password" onClose={() => setShowSetPasswordModal(false)}>
          {({ close }) => (
            <SetPasswordForm user={user} onSuccess={handleSetPasswordSuccess} onCancel={close} />
          )}
        </ModalCard>
      )}
    </Page>
  );
}