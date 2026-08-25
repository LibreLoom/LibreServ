import { useEffect, useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, HardDrive, Home, Image as ImageIcon, MapPinOff, Settings } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import IconCircle from "../components/ui/IconCircle";
import Navbar from "../components/ui/Navbar";
import { notfound as quips } from "../assets/greetings.jsx";
import { useAuth } from "../context/AuthContext";

const PLACES = [
  { to: "/drives", label: "Drives", icon: HardDrive },
  { to: "/gallery", label: "Photos", icon: ImageIcon },
  { to: "/settings", label: "Settings", icon: Settings },
];

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return hash >>> 0;
}

function pickQuip(path) {
  if (!Array.isArray(quips) || quips.length === 0) {
    return "This page isn't on Luna. Head home and try another door.";
  }
  return quips[hashString(path) % quips.length];
}

export default function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, setup } = useAuth();
  const attemptedPath = `${location.pathname || "/"}${location.search || ""}${location.hash || ""}`;
  const quip = useMemo(() => pickQuip(attemptedPath), [attemptedPath]);
  const showNav = Boolean(user && setup?.setup_completed);

  useEffect(() => {
    const previous = document.title;
    document.title = "Nothing here · Luna";
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    document.getElementById("main-content")?.focus?.();
  }, [attemptedPath]);

  function handleGoBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate("/", { replace: true });
  }

  const page = (
    <Page
      title="Nothing here"
      titleId="not-found-title"
      leftContent={<IconCircle icon={MapPinOff} size="sm" variant="default" />}
    >
      <Card className="max-w-2xl mx-auto">
        <div className="relative h-24 mb-6" aria-hidden="true">
          <div className="absolute inset-x-6 top-0 h-16 rounded-large-element bg-primary/20 border border-primary/20" />
          <div className="absolute inset-x-3 top-3 h-16 rounded-large-element bg-primary/30 border border-primary/20" />
          <div className="absolute inset-x-0 top-6 h-16 rounded-large-element bg-primary text-secondary flex items-center justify-center px-4">
            <p className="font-mono text-lg sm:text-xl truncate">This isn't a place on Luna</p>
          </div>
        </div>

        <p className="text-primary text-sm leading-relaxed max-w-prose">{quip}</p>

        <p className="mt-5 text-primary text-xs font-mono">You opened</p>
        <p className="mt-2 rounded-pill bg-primary text-secondary font-mono text-xs px-4 py-2 overflow-x-auto">
          {attemptedPath || "/"}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="primary" onClick={handleGoBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            Go back
          </Button>
          <Button asChild variant="outline">
            <Link to="/">
              <Home size={16} aria-hidden="true" />
              Home
            </Link>
          </Button>
        </div>
      </Card>

      <div className="max-w-2xl mx-auto mt-4">
        <Card>
          <p className="font-mono text-sm text-primary mb-3">Try one of these</p>
          <div className="flex flex-wrap gap-2">
            {PLACES.map((place) => (
              <Button key={place.to} asChild size="sm" variant="primary">
                <Link to={place.to}>
                  <place.icon size={14} aria-hidden="true" />
                  {place.label}
                </Link>
              </Button>
            ))}
          </div>
        </Card>
      </div>
    </Page>
  );

  if (!showNav) {
    return <div data-slot="not-found-shell">{page}</div>;
  }

  return (
    <div data-slot="not-found-shell" className="min-h-screen bg-primary text-secondary">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {page}
      <Navbar />
    </div>
  );
}
