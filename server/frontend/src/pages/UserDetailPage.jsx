import { cn } from "@/lib/utils";
import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import Card from "../components/cards/Card";
import CardButton from "../components/cards/CardButton";
import Button from "../components/ui/Button";
import VerificationCard from "../components/cards/VerificationCard";
import ModalCard from "../components/cards/ModalCard";
import ObjectNotFound from "./ObjectNotFound";
import StateOverlay from "../components/common/StateOverlay";
import Page from "../components/ui/Page";
import api from "../lib/api";
import { User, Mail, Shield, Calendar, Clock } from "lucide-react";
import ChangeEmailForm from "../components/common/forms/ChangeEmailForm";
import RoleChangeForm from "../components/common/forms/RoleChangeForm";
import ResetPasswordForm from "../components/common/forms/ResetPasswordForm";
import { useTimeFormat } from "../hooks/useTimeFormat";
import { useSettingsStatus } from "../hooks/useSettingsStatus";

export default function UserDetailPage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { formatDateLong } = useTimeFormat();
  const { smtpConfigured } = useSettingsStatus();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false);

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

  const handleResetPasswordSuccess = () => {
    setShowResetPasswordModal(false);
  };

  const formatDate = (dateString) => {
    if (!dateString) return "Unknown";
    return formatDateLong(dateString);
  };
  const showName = Boolean(user?.username || user?.email);
  const nameValue = user?.username || user?.email || "";
  const userTitle = (
    <span className="inline-flex flex-wrap items-center justify-center gap-2">
      <span>User:</span>
      <span
        className={cn(
          "transition-all duration-300 ease-out",
          showName ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1",
          "motion-reduce:transition-none",
        )}
        aria-hidden={!showName}
      >
        {showName ? nameValue : ""}
      </span>
    </span>
  );

  if (!loading && (notFound || (!error && !user))) {
    // If the API returns nothing or 404 for an existing route, show a 404 panel.
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

  return (
    <Page data-slot="user-detail"
      title={userTitle}
      titleId="user-detail-title"
      leftContent={
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary text-secondary">
          <User size={22} className="text-secondary" aria-hidden />
        </span>
      }
      headerClassName="mb-10"
    >
      {loading && showLoading && (
        <StateOverlay message="Loading user..." />
      )}

      {error && (
        <StateOverlay kind="error">
          <p>Error: {error}</p>
        </StateOverlay>
      )}

      {/* User Details */}
      {!loading && !error && user && (
        <>
          <section
            className="grid grid-cols-1 md:grid-cols-2 gap-6"
            aria-label="User details"
          >
            {/* Summary cards show key profile data at a glance. */}
            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Mail size={20} className="text-accent" aria-hidden="true" />
                <h2 className="text-xl font-mono font-normal">Email</h2>
              </div>
              <p className="text-lg ml-8">{user.email}</p>
            </Card>

            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Shield size={20} className="text-accent" aria-hidden="true" />
                <h2 className="text-xl font-mono font-normal">Role</h2>
              </div>
              <p className="text-lg ml-8">
                {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
              </p>
            </Card>

            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Calendar
                  size={20}
                  className="text-accent"
                  aria-hidden="true"
                />
                <h2 className="text-xl font-mono font-normal">
                  Account Created
                </h2>
              </div>
              <p className="text-lg ml-8">{formatDate(user.created_at)}</p>
            </Card>

            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Calendar
                  size={20}
                  className="text-accent"
                  aria-hidden="true"
                />
                <h2 className="text-xl font-mono font-normal">Last Updated</h2>
              </div>
              <p className="text-lg ml-8">{formatDate(user.updated_at)}</p>
            </Card>

            <Card className="motion-safe:transition hover:scale-[1.02]">
              <div className="flex items-center gap-3 mb-3">
                <Clock size={20} className="text-accent" aria-hidden="true" />
                <h2 className="text-xl font-mono font-normal">Last Login</h2>
              </div>
              <p className="text-lg ml-8">{formatDate(user.last_login) || "Never"}</p>
            </Card>
            {/* Ideas for more cards? */}
          </section>
          <section className="mt-6">
            <Card surface="primary">
              <h2 className="text-2xl font-mono font-normal mb-6">
                User Tools
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() => setShowEditModal(true)}
                  className="h-full"
                >
                  <span className="text-sm font-medium">Change Email</span>
                </Button>
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() => setShowRoleModal(true)}
                  className="h-full"
                >
                  <span className="text-sm font-medium">Change Role</span>
                </Button>
                {smtpConfigured && (
                  <Button
                    variant="secondary"
                    fullWidth
                    onClick={() => setShowResetPasswordModal(true)}
                    className="h-full"
                  >
                    <span className="text-sm font-medium">Reset Password</span>
                  </Button>
                )}
                <Button
                  variant="accent"
                  fullWidth
                  onClick={() => setShowDeleteConfirm(true)}
                  className="h-full"
                >
                  <span className="text-sm font-medium">Delete User</span>
                </Button>
              </div>
            </Card>
          </section>
        </>
      )}

      {showDeleteConfirm && user && (
        <VerificationCard
          title="Delete User"
          message={`Are you sure you want to delete user "${user.username}"? This action cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={handleDeleteUser}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showEditModal && user && (
        <ModalCard title="Change Email" onClose={() => setShowEditModal(false)}>
          <ChangeEmailForm
            user={user}
            onSuccess={handleEditSuccess}
            onCancel={() => setShowEditModal(false)}
          />
        </ModalCard>
      )}

      {showRoleModal && user && (
        <ModalCard title="Change Role" onClose={() => setShowRoleModal(false)}>
          <RoleChangeForm
            user={user}
            onSuccess={handleRoleChangeSuccess}
            onCancel={() => setShowRoleModal(false)}
          />
        </ModalCard>
      )}

      {showResetPasswordModal && user && (
        <ModalCard
          title="Reset Password"
          onClose={() => setShowResetPasswordModal(false)}
        >
          <ResetPasswordForm
            user={user}
            onSuccess={handleResetPasswordSuccess}
            onCancel={() => setShowResetPasswordModal(false)}
          />
        </ModalCard>
      )}
    </Page>
  );
}
