import PropTypes from "prop-types";
import { Plus, MessageSquare } from "lucide-react";
import Card from "../cards/Card.jsx";
import Button from "../ui/Button.jsx";
import ConversationItem from "./ConversationItem.jsx";

function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
}) {
  return (
    <Card
      noHeightAnim
      noPopIn
      icon={MessageSquare}
      title="Conversations"
      headerActions={
        <button
          type="button"
          onClick={onNewChat}
          className="rounded-pill bg-primary text-secondary p-1.5 motion-safe:transition-all hover:ring-2 hover:ring-accent cursor-pointer focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="New conversation"
        >
          <Plus size={14} />
        </button>
      }
    >
      <div className="space-y-1 pt-2">
        {conversations.length === 0 ? (
          <p className="text-sm text-primary/50 py-2">No conversations yet</p>
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
};

export default ConversationSidebar;
