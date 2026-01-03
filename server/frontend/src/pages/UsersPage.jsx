import { useState, useEffect } from "react";
import Card from "../components/common/cards/Card";
import UserCard from "../components/common/cards/UserCard";
import VerificationCard from "../components/common/cards/VerificationCard";
import api from "../lib/api";

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showVerification, setShowVerification] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);

  // Fetch users from API
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await api("/users");
        const data = await response.json();
        setUsers(data.users || []);
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    };
    fetchUsers();
  }, []);

  const handleDeleteClick = (userId, username) => {
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
      console.error("Error deleting user:", err);
      alert("Failed to delete user: " + err.message);
    }
  };

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="users-title"
      id="main-content"
      tabIndex={-1}
    >
      <header>
        <Card>
          <h1 id="users-title" className="text-2xl font-bold text-left">
            Users
          </h1>
        </Card>
      </header>

      {loading && (
        <div className="fixed inset-0 flex items-center justify-center">
          <Card className="w-[70vw] sm:w-[20vw]">
            <div className="my-5 text-center" role="status" aria-live="polite">
              <p>Loading users...</p>
            </div>
          </Card>
        </div>
      )}

      {error && (
        <div className="mt-5 text-center text-accent" role="alert">
          <p>Error: {error}</p>
        </div>
      )}

      {!loading && !error && users.length === 0 && (
        <div className="mt-5 text-center">
          <p>No users found</p>
        </div>
      )}

      {!loading && !error && users.length > 0 && (
        <section
          className="mt-5 flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 content-start"
          aria-label="User list"
        >
          {users.map((user) => (
            <UserCard
              key={user.id}
              id={user.id}
              username={user.username}
              email={user.email}
              role={user.role}
              createdAt={user.created_at}
              onDelete={() => handleDeleteClick(user.id, user.username)}
            />
          ))}
        </section>
      )}

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
    </main>
  );
}
