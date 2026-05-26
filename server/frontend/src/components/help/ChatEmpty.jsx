import PropTypes from "prop-types";
import { Bot } from "lucide-react";
import IconCircle from "../ui/IconCircle.jsx";

const SUGGESTIONS = [
  "My Nextcloud is not responding",
  "Check the health of all my apps",
  "Help me set up backups",
  "Something is wrong with my domain",
];

function ChatEmpty({ onSuggestionClick }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 px-6 text-center">
      <IconCircle icon={Bot} size="xl" variant="accent" className="mb-4" />
      <h2 className="text-lg font-mono text-primary mb-2">How can we help?</h2>
      <p className="text-sm text-primary/60 max-w-sm mb-6">
        Our AI agents work together to check your apps, read logs, diagnose issues, and fix problems. Just describe what you need.
      </p>
      <div className="flex flex-wrap gap-2 justify-center max-w-md">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggestionClick?.(s)}
            className="rounded-pill border border-primary/10 bg-primary/3 px-3 py-1.5 text-xs text-primary/60 hover:text-primary hover:bg-primary/5 motion-safe:transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

ChatEmpty.propTypes = {
  onSuggestionClick: PropTypes.func,
};

export default ChatEmpty;
