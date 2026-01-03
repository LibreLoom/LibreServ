import { useParams } from "react-router-dom";
import { useState, useEffect } from "react";
import Card from "../components/common/cards/Card";
import CardButton from "../components/common/cards/CardButton";
import NotFoundPage from "./NotFoundPage";
import api from "../lib/api";
import { User, Mail, Shield, Calendar } from "lucide-react";

export default function UserDetailPage() {
  const { userId } = useParams();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const response = await api(`/users/${userId}`);
        const userData = await response.json();
        setUser(userData);
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    };
    fetchUser();
  }, [userId]);

  if (loading) {
    return (
      <main
        className="bg-primary text-secondary px-8 pt-5 pb-32"
        id="main-content"
        tabIndex={-1}
      >
        <Card>
          <p>Loading user...</p>
        </Card>
      </main>
    );
  }

  if (error || !user) {
    return <NotFoundPage includeMain={false} />;
  }

  const formatDate = (dateString) => {
    if (!dateString) return "Unknown";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="user-detail-title"
      id="main-content"
      tabIndex={-1}
    >
      {/* Header */}
      <header className="px-0 mb-10">
        <Card>
          <div className="flex items-center gap-4 justify-between">
            <div className="flex items-center gap-4">
              <div className="h-10 w-10 rounded-pill bg-primary text-secondary flex items-center justify-center">
                <User size={30} aria-hidden="true" />
              </div>
              <h1 id="user-detail-title" className="text-2xl font-bold">
                {user.username}
              </h1>
            </div>
            <p className="text-lg text-accent font-semibold">
              {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
            </p>
          </div>
        </Card>
      </header>

      {/* User Details */}
      <section
        className="grid grid-cols-1 md:grid-cols-2 gap-6"
        aria-label="User details"
      >
        <Card className="motion-safe:transition hover:scale-[1.02]">
          <div className="flex items-center gap-3 mb-3">
            <Mail size={20} className="text-accent" aria-hidden="true" />
            <h2 className="text-xl font-semibold">Email</h2>
          </div>
          <p className="text-lg ml-8">{user.email}</p>
        </Card>

        <Card className="motion-safe:transition hover:scale-[1.02]">
          <div className="flex items-center gap-3 mb-3">
            <Shield size={20} className="text-accent" aria-hidden="true" />
            <h2 className="text-xl font-semibold">Role</h2>
          </div>
          <p className="text-lg ml-8">
            {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
          </p>
        </Card>

        <Card className="motion-safe:transition hover:scale-[1.02]">
          <div className="flex items-center gap-3 mb-3">
            <Calendar size={20} className="text-accent" aria-hidden="true" />
            <h2 className="text-xl font-semibold">Account Created</h2>
          </div>
          <p className="text-lg ml-8">{formatDate(user.created_at)}</p>
        </Card>

        <Card className="motion-safe:transition hover:scale-[1.02]">
          <div className="flex items-center gap-3 mb-3">
            <Calendar size={20} className="text-accent" aria-hidden="true" />
            <h2 className="text-xl font-semibold">Last Updated</h2>
          </div>
          <p className="text-lg ml-8">{formatDate(user.updated_at)}</p>
        </Card>
        {/* Ideas for more cards? */}
      </section>
      <section className="mt-6">
        <Card className="bg-primary! text-secondary! border-2 border-secondary">
          <h2 className="text-2xl font-bold mb-6">User Tools</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CardButton
              action="#"
              actionLabel="Reset Password"
              className="bg-secondary! text-primary! hover:bg-primary! hover:text-secondary! hover:outline-secondary! mt-0 py-4!"
            />
            <CardButton
              action="#"
              actionLabel="Change Role"
              className="bg-secondary! text-primary! hover:bg-primary! hover:text-secondary! hover:outline-secondary! mt-0 py-4!"
            />
            <CardButton
              action="#"
              actionLabel="Edit User"
              className="bg-secondary! text-primary! hover:bg-primary! hover:text-secondary! hover:outline-secondary! mt-0 py-4!"
            />
            <CardButton
              action="#"
              actionLabel="Delete User"
              className="bg-accent! text-primary! hover:bg-primary! hover:text-accent! hover:outline-accent! mt-0 py-4!"
            />
          </div>
        </Card>
      </section>
    </main>
  );
}
