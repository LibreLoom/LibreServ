import PropTypes from "prop-types";
import { Plus, MessageSquare, Settings } from "lucide-react";
import Card from "../cards/Card.jsx";
import ConversationItem from "./ConversationItem.jsx";

function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onOpenSettings,
}) {
  return (
    <Card
      data-slot="help-conversation-sidebar"
      noHeightAnim
      noPopIn
      icon={MessageSquare}
      title="Previous Sessions"
      headerActions={
        <button
          type="button"
          onClick={onNewChat}
          className="rounded-pill bg-primary text-secondary p-1.5 motion-safe:transition-all hover:ring-2 hover:ring-accent cursor-pointer focus-visible:ring-2 focus-visible:ring-accent no-focus-outline"
          aria-label="New conversation"
        >
          <Plus size={14} />
        </button>
      }
      className="h-full flex flex-col"
    >
      <div className="flex-1 space-y-1 pt-2 min-h-0 overflow-y-auto">
        {conversations.length === 0 ? (
          <p className="text-sm text-primary/50 py-2">No sessions yet</p>
        ) : (
          conversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              title={conv.title}
              date={conv.date}
              status={conv.status}
              isActive={conv.id === activeId}
              onClick={() => onSelect?.(conv.id)}
            />
          ))
        )}
      </div>
      {onOpenSettings && (
        <div className="mt-3 pt-3 border-t border-primary/10">
          <button
            type="button"
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-large-element text-sm font-mono text-primary/70 hover:bg-primary/5 hover:text-primary motion-safe:transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent no-focus-outline"
          >
            <Settings size={14} />
            Settings
          </button>
        </div>
      )}
    </Card>
  );
}

ConversationSidebar.propTypes = {
  conversations: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      title: PropTypes.string.isRequired,
      date: PropTypes.string,
      status: PropTypes.string,
    })
  ).isRequired,
  activeId: PropTypes.string,
  onSelect: PropTypes.func,
  onNewChat: PropTypes.func,
  onOpenSettings: PropTypes.func,
};

export default ConversationSidebar;
