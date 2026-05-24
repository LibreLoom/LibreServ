import { useState } from "react";
import PropTypes from "prop-types";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Camera,
  Eye,
} from "lucide-react";

const AVATAR_SHAPES = {
  diamond: "rotate-45 scale-75",
  circle: "rounded-full",
  triangle: "rounded-t-full rounded-b-sm",
  hexagon: "clip-hexagon",
  square: "rounded-lg",
};

function AgentAvatar({ shape, color, size = 24 }) {
  const shapeClass = AVATAR_SHAPES[shape] || "rounded-full";
  return (
    <div
      className={`shrink-0 ${shapeClass} flex items-center justify-center`}
      style={{
        width: size,
        height: size,
        backgroundColor: color || "#767676",
      }}
    />
  );
}

AgentAvatar.propTypes = {
  shape: PropTypes.string,
  color: PropTypes.string,
  size: PropTypes.number,
};

function ToolCallBlock({ call, result }) {
  const [expanded, setExpanded] = useState(false);

  const toolLabel = call.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const statusIcon = result?.is_error ? (
    <XCircle size={12} className="text-error shrink-0" />
  ) : result ? (
    <CheckCircle size={12} className="text-success shrink-0" />
  ) : (
    <AlertTriangle size={12} className="text-accent shrink-0 animate-pulse" />
  );

  return (
    <div className="border-l-2 border-accent/20 pl-3 py-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-left text-xs font-mono text-primary/70 hover:text-primary/90 cursor-pointer"
        aria-expanded={expanded}
      >
        {statusIcon}
        <span className="flex-1">{toolLabel}</span>
        <ChevronDown
          size={12}
          className={`shrink-0 motion-safe:transition-transform duration-200 ${expanded ? "rotate-180" : "rotate-0"}`}
        />
      </button>
      {expanded && result && (
        <div className={`mt-1 rounded-large-element p-2 text-xs font-mono ${result.is_error ? "bg-error/5" : "bg-success/5"}`}>
          <pre className="whitespace-pre-wrap break-all text-primary/60">
            {result.content?.length > 300 ? result.content.slice(0, 300) + "..." : result.content}
          </pre>
        </div>
      )}
    </div>
  );
}

ToolCallBlock.propTypes = {
  call: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    agent_id: PropTypes.string,
  }).isRequired,
  result: PropTypes.shape({
    id: PropTypes.string,
    content: PropTypes.string,
    is_error: PropTypes.bool,
  }),
};

function AgentDeliberationBlock({ agentId, avatarShape, avatarColor, events, toolResults }) {
  const [expanded, setExpanded] = useState(true);

  const messages = events.filter((e) => e.type === "agent_message" && e.agent_id === agentId);
  const toolCalls = events.filter((e) => e.type === "tool_call" && e.agent_id === agentId);
  const votes = events.filter((e) => e.type === "vote" && e.agent_id === agentId);

  return (
    <div className="border border-primary/10 rounded-large-element overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-3 text-left hover:bg-primary/5 cursor-pointer"
        aria-expanded={expanded}
      >
        <AgentAvatar shape={avatarShape} color={avatarColor} size={20} />
        <span className="flex-1 text-sm font-mono text-primary/80">{agentId}</span>
        <span className="text-[10px] text-primary/40">
          {toolCalls.length} action{toolCalls.length !== 1 ? "s" : ""}
          {votes.length > 0 && ` · ${votes.length} vote${votes.length !== 1 ? "s" : ""}`}
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {messages.map((msg, i) => (
            <p key={`msg-${i}`} className="text-xs text-primary/70 leading-relaxed">
              {msg.content}
            </p>
          ))}

          {toolCalls.map((tc) => (
            <ToolCallBlock
              key={tc.id}
              call={tc}
              result={toolResults.find((r) => r.id === tc.id)}
            />
          ))}

          {votes.map((v, i) => (
            <div key={`vote-${i}`} className="flex items-center gap-2 text-xs">
              {v.decision === "approve" ? (
                <CheckCircle size={12} className="text-success" />
              ) : (
                <XCircle size={12} className="text-error" />
              )}
              <span className="font-mono text-primary/60">{v.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

AgentDeliberationBlock.propTypes = {
  agentId: PropTypes.string.isRequired,
  avatarShape: PropTypes.string,
  avatarColor: PropTypes.string,
  events: PropTypes.array.isRequired,
  toolResults: PropTypes.array.isRequired,
};

function ConsensusBlock({ proposal, consensus }) {
  if (!consensus) return null;

  return (
    <div className={`rounded-large-element p-3 ${consensus.result === "approved" ? "bg-success/5" : "bg-error/5"}`}>
      <div className="flex items-center gap-2 mb-2">
        {consensus.result === "approved" ? (
          <CheckCircle size={14} className="text-success" />
        ) : (
          <XCircle size={14} className="text-error" />
        )}
        <span className="text-sm font-mono text-primary/80">
          {consensus.result === "approved" ? "Approved" : "Rejected"}
        </span>
      </div>
      {proposal?.tool_calls?.length > 0 && (
        <p className="text-xs text-primary/60 font-mono mb-2">
          {proposal.tool_calls.map((tc) => tc.name).join(", ")}
        </p>
      )}
      {consensus.votes?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {consensus.votes.map((v, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <AgentAvatar shape={v.avatar_shape} color={v.avatar_color} size={14} />
              {v.decision === "approve" ? (
                <CheckCircle size={10} className="text-success" />
              ) : (
                <XCircle size={10} className="text-error" />
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

ConsensusBlock.propTypes = {
  proposal: PropTypes.shape({
    tool_calls: PropTypes.array,
  }),
  consensus: PropTypes.shape({
    result: PropTypes.string,
    votes: PropTypes.array,
  }),
};

export default function AgentTrace({ events }) {
  const [isOpen, setIsOpen] = useState(false);

  const agentThinkingEvents = events.filter((e) => e.type === "agent_thinking");
  const toolCallEvents = events.filter((e) => e.type === "tool_call");
  const toolResultEvents = events.filter((e) => e.type === "tool_result");
  const proposalEvents = events.filter((e) => e.type === "proposal");
  const consensusEvents = events.filter((e) => e.type === "consensus");
  const snapshotEvents = events.filter((e) => e.type === "snapshot_created");

  const agentIds = [...new Set(agentThinkingEvents.map((e) => e.agent_id))];
  const agentMeta = {};
  for (const e of agentThinkingEvents) {
    agentMeta[e.agent_id] = { shape: e.avatar_shape, color: e.avatar_color, model: e.model };
  }

  if (agentThinkingEvents.length === 0 && toolCallEvents.length === 0) return null;

  const activeAgents = agentThinkingEvents.filter(
    (e, i, arr) => arr.findIndex((a) => a.agent_id === e.agent_id) === i
  );

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-primary/50 hover:text-primary/70 cursor-pointer"
        aria-expanded={isOpen}
      >
        <Eye size={12} />
        <span className="font-mono">
          {activeAgents.length} agent{activeAgents.length !== 1 ? "s" : ""} deliberating
        </span>
        {snapshotEvents.length > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded-pill bg-info/10 text-info px-1.5 py-0.5 text-[10px] font-mono">
            <Camera size={8} />
            {snapshotEvents.length} backup{snapshotEvents.length !== 1 ? "s" : ""}
          </span>
        )}
        {consensusEvents.length > 0 && (
          <span className="text-[10px] text-primary/30">
            · {consensusEvents.filter((c) => c.result === "approved").length} approved
            {consensusEvents.filter((c) => c.result === "rejected").length > 0 &&
              `, ${consensusEvents.filter((c) => c.result === "rejected").length} rejected`}
          </span>
        )}
        <ChevronDown
          size={12}
          className={`shrink-0 motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
        />
      </button>

      {isOpen && (
        <div className="mt-3 space-y-3">
          {agentIds.map((id) => (
            <AgentDeliberationBlock
              key={id}
              agentId={id}
              avatarShape={agentMeta[id]?.shape}
              avatarColor={agentMeta[id]?.color}
              events={events}
              toolResults={toolResultEvents}
            />
          ))}

          {consensusEvents.map((c, i) => (
            <ConsensusBlock
              key={i}
              proposal={proposalEvents.find((p) => p.id === c.proposal_id)}
              consensus={c}
            />
          ))}
        </div>
      )}
    </div>
  );
}

AgentTrace.propTypes = {
  events: PropTypes.arrayOf(
    PropTypes.shape({
      type: PropTypes.string.isRequired,
    })
  ).isRequired,
};

export { AgentAvatar };
