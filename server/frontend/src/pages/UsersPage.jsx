import { useState, useEffect } from "react";
import { User, Shield, Trash2, Settings, Plus, Clock } from "lucide-react";
import { Link } from "react-router-dom";
import Card from "../components/cards/Card";
import HeaderCard from "../components/cards/HeaderCard";
import VerificationCard from "../components/cards/VerificationCard";
import Table from "../components/common/Table";
import Pill from "../components/common/Pill";
import api from "../lib/api";
import { useTimeFormat } from "../hooks/useTimeFormat";

function formatLastLogin(dateString) {
  if (!dateString) return "Never";
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function UsersPage() {
  const { use12HourTime } = useTimeFormat();
  // Track server results + UI state for loading and destructive actions.
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showVerification, setShowVerification] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);

  // Fetch users from API
  useEffect(() => {
    let delayTimer;
    const fetchUsers = async () => {
      try {
        delayTimer = setTimeout(() => {
          setShowLoading(true);
        }, 500);
        const response = await api("/users");
        const data = await response.json();
        setUsers(data.data || []);
      } catch (err) {
        setError(err.message);
      } finally {
        clearTimeout(delayTimer);
        setShowLoading(false);
        setLoading(false);
      }
    };
    fetchUsers();
    return () => clearTimeout(delayTimer);
  }, []);

  const handleDeleteClick = (userId, username) => {
    // Store selection so the confirmation modal can be explicit.
    setUserToDelete({ id: userId, name: username });
    setShowVerification(true);
  };

  const handleConfirmDelete = async () => {
    try {
      // Get CSRF token
      const csrfResponse = await api("/auth/csrf");
      const csrfData = await csrfResponse.json();

      await api(`/users/${userToDelete.id}`, {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": csrfData.csrf_token,
        },
      });

      // Remove user from local state
      setUsers(users.filter((user) => user.id !== userToDelete.id));
      setShowVerification(false);
      setUserToDelete(null);
    } catch (err) {
      const message = err?.message || "Unable to delete user. Please try again.";
      if (message.includes("last admin") || message.includes("last admin user")) {
        alert("Cannot delete the last admin user. There must be at least one admin.");
      } else {
        alert(message);
      }
    }
  };

  return (
    <>
      <main
        className={`bg-primary text-secondary px-8 pt-5 pb-32 ${showVerification ? "pop-out" : "pop-in"}`}
        aria-labelledby="users-title"
        id="main-content"
        tabIndex={-1}
      >
        <header>
          <HeaderCard id="users-title" title="Users" />
        </header>

        {loading && showLoading && (
          // Delayed loader avoids flicker on fast responses.
          <div className="fixed inset-0 flex items-center justify-center bg-primary/60 backdrop-blur-sm">
            <Card className="w-[70vw] sm:w-[20vw]">
              <div
                className="my-5 text-center"
                role="status"
                aria-live="polite"
              >
                <p>Loading users...</p>
              </div>
            </Card>
          </div>
        )}

        {error && (
          // Full-screen error so it can't be missed.
          <div className="fixed inset-0 flex items-center justify-center bg-primary/60 backdrop-blur-sm">
            <Card className="w-[70vw] sm:w-[20vw] border-2 border-accent">
              <div
                className="my-5 text-center"
                role="status"
                aria-live="polite"
              >
                <p>Error: {error}</p>
              </div>
            </Card>
          </div>
        )}

        {!loading && !error && users.length === 0 && (
          <div className="mt-5 text-center">
            <p>No users found</p>
          </div>
        )}

        {!loading && !error && users.length > 0 && (
          <section className="mt-5" aria-label="User list">
            {/* Mobile: Card list */}
            <div className="flex flex-col gap-3 lg:hidden">
              {users.map((user) => (
                <Card key={user.id} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <Link
                      to={`/users/${user.id}`}
                      className="flex items-center gap-3 flex-1 min-w-0"
                    >
                      <div className="h-10 w-10 shrink-0 rounded-full bg-primary text-secondary flex items-center justify-center">
                        <User size={18} aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold truncate">
                          {user.username}
                        </div>
                        <div
                          className={`text-sm ${user.role === "admin" ? "text-accent" : "text-primary/60"}`}
                        >
                          {user.role.charAt(0).toUpperCase() +
                            user.role.slice(1)}
                        </div>
                        <div className="text-xs text-primary/40 flex items-center gap-1">
                          <Clock size={10} aria-hidden="true" />
                          {formatLastLogin(user.last_login, use12HourTime)}
                        </div>
                      </div>
                    </Link>
                    <div className="flex items-center gap-1 shrink-0">
                       <Link
                         to={`/users/${user.id}`}
                         className="p-2 rounded-full hover:bg-primary/10 text-primary/60 hover:text-primary motion-safe:transition-colors focus-visible:ring-2 focus:ring-primary focus:ring-offset-2"
                         aria-label={`Manage ${user.username}`}
                       >
                        <Settings size={18} />
                      </Link>
                       <button
                         type="button"
                         onClick={() =>
                           handleDeleteClick(user.id, user.username)
                         }
                         className="p-2 rounded-full hover:bg-accent/20 text-primary/60 hover:text-accent motion-safe:transition-colors focus-visible:ring-2 focus:ring-accent focus:ring-offset-2"
                         aria-label={`Delete ${user.username}`}
                       >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>

{/* Desktop: Table */}
            <Card className="overflow-hidden p-0 hidden lg:block">
              <div className="p-4">
                <Table
                  columns={[
                    {
                      key: "username",
                      label: "User",
                      render: (row) => (
                        <Link
                          to={`/users/${row.id}`}
                          className="inline-flex items-center gap-2"
                        >
                          <span className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                            <User size={14} className="text-accent" />
                          </span>
                          <span className="font-semibold text-sm">{row.username}</span>
                        </Link>
                      ),
                    },
                    {
                      key: "email",
                      label: "Email",
                      render: (row) => (
                        <Link
                          to={`/users/${row.id}`}
                          className="inline-flex items-center px-2.5 py-1 rounded-pill bg-primary/10 text-sm text-primary/70"
                        >
                          {row.email}
                        </Link>
                      ),
                    },
                    {
                      key: "role",
                      label: "Role",
                      render: (row) => (
                        <Pill variant={row.role === "admin" ? "accent" : "default"}>
                          <Shield size={12} className="mr-1" />
                          {row.role.charAt(0).toUpperCase() + row.role.slice(1)}
                        </Pill>
                      ),
                    },
                    {
                      key: "last_login",
                      label: "Last Login",
                      render: (row) => <Pill variant="muted">{formatLastLogin(row.last_login, use12HourTime)}</Pill>,
                    },
                    {
                      key: "actions",
                      label: "Actions",
                      srOnly: true,
                      width: "w-12",
                      render: (row) => (
                        <span className="inline-flex items-center gap-1">
                          <Link
                            to={`/users/${row.id}`}
                            className="p-1.5 rounded-full hover:bg-primary/10 text-primary/60 hover:text-primary motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                            aria-label={`Manage ${row.username}`}
                          >
                            <Settings size={16} />
                          </Link>
                          <button
                            type="button"
                            onClick={() => handleDeleteClick(row.id, row.username)}
                            className="p-1.5 rounded-full hover:bg-accent/20 text-primary/60 hover:text-accent motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                            aria-label={`Delete ${row.username}`}
                          >
                            <Trash2 size={16} />
                          </button>
                        </span>
                      ),
                    },
                  ]}
                  data={users}
                  rowKey="id"
                />
              </div>
            </Card>
          </section>
        )}

        {!loading && !error && users.length > 0 && (
          <Link
            to="/users/create"
             className="fixed bottom-8 right-8 z-40 bg-secondary text-primary rounded-full p-4 motion-safe:transition-all hover:scale-110 focus-visible:ring-2 focus:ring-primary focus:ring-offset-2"
            aria-label="Add new user"
          >
            <Plus size={32} aria-hidden="true" />
          </Link>
        )}
      </main>

      {showVerification && userToDelete && (
        <VerificationCard
          title="Delete User"
          message={`Are you sure you want to delete user "${userToDelete.name}"? This action cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setShowVerification(false)}
        />
      )}
    </>
  );
}
