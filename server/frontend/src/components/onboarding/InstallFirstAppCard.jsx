import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Download, X } from "lucide-react";
import Card from "../cards/Card";
import Button from "../ui/Button";

const STORAGE_KEY = "libreserv_install_first_app_dismissed";

/**
 * InstallFirstAppCard — a dismissible banner shown when no apps are installed.
 * Focused call to action: install your first app. Card + accent border +
 * icon header + animated collapse on dismiss, stripped to a single action.
 */
export default function InstallFirstAppCard() {
  const [visible, setVisible] = useState(
    () => !localStorage.getItem(STORAGE_KEY),
  );
  const [hiding, setHiding] = useState(false);
  const [contentHeight, setContentHeight] = useState(null);
  const contentRef = useRef(null);

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, []);

  function handleDismiss() {
    localStorage.setItem(STORAGE_KEY, "true");
    setHiding(true);
  }

  function handleTransitionEnd(e) {
    if (hiding && e.propertyName === "maxHeight") {
      setVisible(false);
    }
  }

  if (!visible) return null;

  const maxH = hiding ? 0 : (contentHeight ?? 300);

  return (
    <div
      data-slot="install-first-app-card"
      onTransitionEnd={handleTransitionEnd}
      className="overflow-hidden transition-all duration-300 ease-in-out"
      style={{ maxHeight: maxH, opacity: hiding ? 0 : 1 }}
    >
      <div ref={contentRef}>
        <Card className="border-accent/40 relative">
          <Button
            variant="ghost"
            size="iconSm"
            surface="secondary"
            onClick={handleDismiss}
            className="absolute top-3 right-3"
            aria-label="Dismiss"
          >
            <X size={18} className="text-primary/50" />
          </Button>

          <div className="flex items-center gap-3 mb-4">
            <Sparkles className="text-accent w-6 h-6" aria-hidden="true" />
            <h2 className="font-mono text-xl text-primary">
              Install your first app
            </h2>
          </div>

          <p className="text-primary/70 text-sm mb-5">
            Your LibreServ is ready. Browse the catalog and install an app to
            get started — file sharing, photo galleries, smart home tools, and
            more.
          </p>

          <Button asChild variant="primary" className="font-mono">
            <Link to="/apps">
              <Download size={16} aria-hidden="true" />
              Browse Apps
            </Link>
          </Button>
        </Card>
      </div>
    </div>
  );
}
