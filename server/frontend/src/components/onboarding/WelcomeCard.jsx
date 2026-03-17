import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Download, Shield, BookOpen, X, CircleCheck } from "lucide-react";
import Card from "../common/cards/Card";

const STORAGE_KEY = "libreserv_welcome_dismissed";

const quickActions = [
  {
    icon: Download,
    title: "Install an App",
    description: "Browse the catalog and install your first app",
    to: "/apps",
    color: "text-accent",
  },
  {
    icon: Shield,
    title: "Configure Settings",
    description: "Set up HTTPS, domains, and system preferences",
    to: "/settings",
    color: "text-success",
  },
  {
    icon: BookOpen,
    title: "Read the Docs",
    description: "Learn how to get the most from your LibreServ",
    to: "/help",
    color: "text-info",
  },
];

export default function WelcomeCard() {
  const [visible, setVisible] = useState(() => !localStorage.getItem(STORAGE_KEY));
  const [hiding, setHiding] = useState(false);
  const [contentHeight, setContentHeight] = useState(null);
  const contentRef = useRef(null);
  const [dontShow, setDontShow] = useState(false);

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, []);

  function handleDismiss() {
    if (dontShow) {
      localStorage.setItem(STORAGE_KEY, "true");
    }
    setHiding(true);
  }

  function handleTransitionEnd(e) {
    if (hiding && e.propertyName === "maxHeight") {
      setVisible(false);
    }
  }

  if (!visible) return null;

  const maxH = hiding ? 0 : (contentHeight ?? 600);

  return (
    <div
      onTransitionEnd={handleTransitionEnd}
      className="overflow-hidden transition-all duration-300 ease-in-out"
      style={{ maxHeight: maxH, opacity: hiding ? 0 : 1 }}
    >
      <div ref={contentRef}>
    <Card className="border-accent/40 relative">
      <button
        onClick={handleDismiss}
        className="absolute top-3 right-3 p-1 rounded-pill hover:bg-primary/20 transition-colors"
        aria-label="Dismiss welcome message"
      >
        <X size={18} className="text-primary/50" />
      </button>

      <div className="flex items-center gap-3 mb-4">
        <Sparkles className="text-accent w-6 h-6" aria-hidden="true" />
        <h2 className="font-mono text-xl text-primary">
          Your LibreServ is ready!
        </h2>
      </div>

      <p className="text-primary/70 text-sm mb-5">
        Here&apos;s what you can do to get started:
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {quickActions.map(({ icon: Icon, title, description, to, color }) => (
          <Link
            key={to}
            to={to}
            className="group flex flex-col items-center text-center p-4 rounded-large-element bg-primary/10 hover:bg-primary/20 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            <Icon
              className={`w-8 h-8 mb-2 ${color} group-hover:scale-110 transition-transform`}
              aria-hidden="true"
            />
            <span className="font-mono text-sm text-primary font-medium">
              {title}
            </span>
            <span className="text-xs text-primary/50 mt-1">{description}</span>
          </Link>
        ))}
      </div>

      <label className="flex items-center gap-2 mt-4 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={dontShow}
          onChange={(e) => setDontShow(e.target.checked)}
          className="sr-only peer"
        />
        <CircleCheck
          size={18}
          className={`transition-colors ${
            dontShow ? "text-accent" : "text-primary/30"
          }`}
        />
        <span className="text-xs text-primary/50">
          Don&apos;t show this again
        </span>
      </label>
    </Card>
      </div>
    </div>
  );
}
