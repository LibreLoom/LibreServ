import { useParams } from "react-router-dom";
import { useState, useEffect } from "react";
import Card from "../components/common/cards/Card";
import CardButton from "../components/common/cards/CardButton";
import HeaderCard from "../components/common/cards/HeaderCard";
import NotFoundPage from "./NotFoundPage";
import api from "../lib/api";
import { User, Mail, Shield, Calendar } from "lucide-react";

export default function UserDetailPage() {
  const { userId } = useParams();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let delayTimer;
    const fetchUser = async () => {
      try {
        delayTimer = setTimeout(() => {
          setShowLoading(true);
        }, 500);
        const response = await api(`/users/${userId}`);
        const userData = await response.json();
        setUser(userData);
      } catch (err) {
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
  const showName = Boolean(user?.username || user?.email);
  const nameValue = user?.username || user?.email || "";
  const userTitle = (
    <span className="inline-flex flex-wrap items-center justify-center gap-2">
      <span>User:</span>
      <span
        className={`transition-all duration-300 ease-out ${
          showName ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        } motion-reduce:transition-none`}
        aria-hidden={!showName}
      >
        {showName ? nameValue : ""}
      </span>
    </span>
  );

  if (!loading && !error && !user) {
    return <NotFoundPage includeMain={false} />;
  }

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="user-detail-title"
      id="main-content"
      tabIndex={-1}
    >
      {/* Header */}
      <header className="mb-10">
        <HeaderCard
          id="user-detail-title"
          title={userTitle}
          leftContent={
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary">
              <User size={22} className="text-secondary" aria-hidden />
            </span>
          }
        />
      </header>

      {loading && showLoading && (
        <div className="fixed inset-0 flex items-center justify-center">
          <Card className="w-[70vw] sm:w-[20vw]">
            <div className="my-5 text-center" role="status" aria-live="polite">
              <p>Loading user...</p>
            </div>
          </Card>
        </div>
      )}

      {error && (
        <div className="fixed inset-0 flex items-center justify-center">
          <Card className="w-[70vw] sm:w-[20vw] border-2 border-accent">
            <div className="my-5 text-center" role="status" aria-live="polite">
              <p>Error: {error}</p>
            </div>
          </Card>
        </div>
      )}

      {/* User Details */}
      {!loading && !error && user && (
        <>
          <section
            className="grid grid-cols-1 md:grid-cols-2 gap-6"
            aria-label="User details"
          >
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
            {/* Ideas for more cards? */}
          </section>
          <section className="mt-6">
            <Card className="bg-primary! text-secondary! border-2 border-secondary">
              <h2 className="text-2xl font-mono font-normal mb-6">
                User Tools
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <CardButton
                  action="#"
                  actionLabel="Reset Password"
                  className="bg-secondary! text-primary! hover:bg-primary! hover:text-secondary! hover:outline-secondary! mt-0! py-4!"
                />
                <CardButton
                  action="#"
                  actionLabel="Change Role"
                  className="bg-secondary! text-primary! hover:bg-primary! hover:text-secondary! hover:outline-secondary! mt-0! py-4!"
                />
                <CardButton
                  action="#"
                  actionLabel="Edit User"
                  className="bg-secondary! text-primary! hover:bg-primary! hover:text-secondary! hover:outline-secondary! mt-0! py-4!"
                />
                <CardButton
                  action="#"
                  actionLabel="Delete User"
                  className="bg-accent! text-primary! hover:bg-primary! hover:text-accent! hover:outline-accent! mt-0! py-4!"
                />
              </div>
            </Card>
          </section>
        </>
      )}
    </main>
  );
}
