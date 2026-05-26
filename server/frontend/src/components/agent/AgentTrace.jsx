import { useState } from "react";
import PropTypes from "prop-types";
import {
  ChevronDown,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Camera,
  Eye,
  Cpu,
  Zap,
  Shield,
} from "lucide-react";
import Pill from "../common/Pill.jsx";

function SmoothReveal({ open, children, className = "" }) {
  return (
    <div
      className={`grid motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-[var(--motion-easing-emphasized)] ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      } ${className}`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

SmoothReveal.propTypes = {
  open: PropTypes.bool,
  children: PropTypes.node,
  className: PropTypes.string,
};

function AgentDot({ shape, color, size = 16 }) {
  const fill = color || "#767676";
  const r = size / 2;
  const s = size * 0.92;
  const offset = (size - s) / 2;

  const shapes = {
    diamond: (
      <rect x={s * 0.3 + offset} y={s * 0.3 + offset} width={s * 0.4} height={s * 0.4} rx={s * 0.08} fill={fill} transform={`rotate(45 ${r} ${r})`} />
    ),
    triangle: (
      <path d={`M${r} ${offset + r * 0.1} Q${r + r * 0.42} ${offset + r * 0.35} ${offset + s * 0.88} ${offset + s * 0.72} Q${offset + s * 0.98} ${offset + s * 0.92} ${offset + s * 0.78} ${offset + s * 0.98} L${offset + s * 0.22} ${offset + s * 0.98} Q${offset + s * 0.02} ${offset + s * 0.98} ${offset + s * 0.12} ${offset + s * 0.72} Q${offset + s * 0.12} ${offset + r * 0.35} ${r} ${offset + r * 0.1} Z`} fill={fill} />
    ),
    hexagon: (
      <path d={`M${r} ${offset + r * 0.08} Q${offset + s * 0.92} ${offset + s * 0.22} ${offset + s * 0.95} ${offset + s * 0.45} L${offset + s * 0.95} ${offset + s * 0.55} L${offset + s * 0.95} ${offset + s * 0.78} Q${offset + s * 0.92} ${offset + s * 0.92} ${r} ${offset + s * 0.92} Q${offset + s * 0.08} ${offset + s * 0.92} ${offset + s * 0.05} ${offset + s * 0.78} L${offset + s * 0.05} ${offset + s * 0.45} Q${offset + s * 0.08} ${offset + s * 0.22} ${r} ${offset + r * 0.08} Z`} fill={fill} />
    ),
    square: (
      <rect x={offset + s * 0.12} y={offset + s * 0.12} width={s * 0.76} height={s * 0.76} rx={s * 0.12} fill={fill} />
    ),
  };

  return (
    <svg width={size} height={size} className="inline-block shrink-0" aria-hidden="true">
      {shapes[shape] || <circle cx={r} cy={r} r={r * 0.92} fill={fill} />}
    </svg>
  );
}

AgentDot.propTypes = {
  shape: PropTypes.string,
  color: PropTypes.string,
  size: PropTypes.number,
};

function ToolCallRow({ call, result }) {
  const [open, setOpen] = useState(false);
  const label = call.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  const statusPill = result?.is_error
    ? <Pill variant="error">failed</Pill>
    : result
      ? <Pill variant="success">done</Pill>
      : <Pill variant="warning">running</Pill>;

  const args = call.arguments
    ? (typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments, null, 2))
    : null;

  return (
    <div className="pl-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-xs font-mono text-primary/70 hover:text-primary motion-safe:transition-colors cursor-pointer rounded-pill px-1 py-0.5 focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={open}
      >
        {statusPill}
        <span className="flex-1 text-left truncate">{label}</span>
        <ChevronDown size={10} className={`shrink-0 motion-safe:transition-transform duration-200 ${open ? "rotate-180" : "rotate-0"}`} />
      </button>
      <SmoothReveal open={open}>
        <div className="mt-1 ml-1 space-y-1.5">
          {args && (
            <div className="rounded-large-element bg-primary/5 p-2 text-[10px] font-mono text-primary/50 whitespace-pre-wrap break-all">
              {args.length > 200 ? args.slice(0, 200) + "..." : args}
            </div>
          )}
          {result && (
            <div className={`rounded-large-element p-2 text-[10px] font-mono ${result.is_error ? "bg-error/5" : "bg-success/5"}`}>
              <pre className="whitespace-pre-wrap break-all text-primary/60">
                {result.content?.length > 300 ? result.content.slice(0, 300) + "..." : result.content}
              </pre>
            </div>
          )}
        </div>
      </SmoothReveal>
    </div>
  );
}

ToolCallRow.propTypes = {
  call: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    arguments: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    agent_id: PropTypes.string,
  }).isRequired,
  result: PropTypes.shape({
    id: PropTypes.string,
    content: PropTypes.string,
    is_error: PropTypes.bool,
  }),
};

function ProposalRow({ proposal, consensus, votes, toolResults }) {
  const [open, setOpen] = useState(false);
  const isWrite = proposal.proposal_type === "write";
  const approved = consensus?.result === "approved";
  const hasConsensus = !!consensus;

  const statusPill = !hasConsensus
    ? <Pill variant="warning">voting</Pill>
    : approved
      ? <Pill variant="success">approved</Pill>
      : <Pill variant="error">rejected</Pill>;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-xs font-mono text-primary/70 hover:text-primary motion-safe:transition-colors cursor-pointer rounded-pill px-1 py-0.5 focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={open}
      >
        {isWrite ? <Zap size={10} className="text-warning shrink-0" /> : <Cpu size={10} className="text-info shrink-0" />}
        {statusPill}
        <span className="flex-1 text-left truncate">
          {isWrite
            ? proposal.tool_calls?.map((tc) => tc.name.replace(/_/g, " ")).join(", ")
            : "Final response"}
        </span>
        <ChevronDown size={10} className={`shrink-0 motion-safe:transition-transform duration-200 ${open ? "rotate-180" : "rotate-0"}`} />
      </button>
      <SmoothReveal open={open}>
        <div className="ml-1 mt-1.5 space-y-2">
          {proposal.tool_calls?.map((tc) => (
            <ToolCallRow
              key={tc.id}
              call={tc}
              result={toolResults.find((r) => r.id === tc.id)}
            />
          ))}
          {proposal.response && (
            <div className="rounded-large-element bg-info/5 p-2 text-xs font-mono text-primary/70 whitespace-pre-wrap">
              {proposal.response}
            </div>
          )}
          {votes?.length > 0 && (
            <div className="space-y-1">
              {votes.map((v, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <AgentDot shape={v.avatar_shape} color={v.avatar_color} size={10} />
                  {v.decision === "approve"
                    ? <Pill variant="success">approve</Pill>
                    : <Pill variant="error">reject</Pill>
                  }
                  <span className="font-mono text-primary/50 truncate">{v.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </SmoothReveal>
    </div>
  );
}

ProposalRow.propTypes = {
  proposal: PropTypes.shape({
    id: PropTypes.string.isRequired,
    agent_id: PropTypes.string,
    type: PropTypes.string,
    tool_calls: PropTypes.array,
    response: PropTypes.string,
  }).isRequired,
  consensus: PropTypes.shape({
    result: PropTypes.string,
  }),
  votes: PropTypes.array,
  toolResults: PropTypes.array,
};

function TurnBlock({ turn, events, toolResults, proposals, consensuses, votes }) {
  const [open, setOpen] = useState(false);

  const thinking = events.filter((e) => e.type === "agent_thinking" && e.turn === turn);
  const messages = events.filter((e) => e.type === "agent_message" && e.turn === turn);
  const toolCalls = events.filter((e) => e.type === "tool_call" && e.turn === turn);
  const usageUpdates = events.filter((e) => e.type === "usage_update" && e.turn === turn);
  const snapshots = events.filter((e) => e.type === "snapshot_created" && e.turn === turn);
  const turnProposals = proposals.filter((p) => p.turn === turn);

  const agentIds = [...new Set(thinking.map((e) => e.agent_id))];
  const agentMeta = {};
  for (const e of thinking) {
    agentMeta[e.agent_id] = { shape: e.avatar_shape, color: e.avatar_color, model: e.model };
  }

  const totalCost = usageUpdates.reduce((sum, u) => sum + (u.turn_cost_usd || 0), 0);
  const totalInputTokens = usageUpdates.reduce((sum, u) => sum + (u.input_tokens || 0), 0);
  const totalOutputTokens = usageUpdates.reduce((sum, u) => sum + (u.output_tokens || 0), 0);

  return (
    <div className="border border-primary/10 rounded-large-element overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-primary/5 motion-safe:transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={open}
      >
        <Pill variant="muted">Turn {turn}</Pill>
        <div className="flex items-center gap-1.5 flex-1 flex-wrap">
          {agentIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1">
              <AgentDot shape={agentMeta[id]?.shape} color={agentMeta[id]?.color} size={10} />
              <span className="text-[10px] font-mono text-primary/50">{id}</span>
            </span>
          ))}
        </div>
        {toolCalls.length > 0 && <Pill variant="accent">{toolCalls.length} tool{toolCalls.length !== 1 ? "s" : ""}</Pill>}
        {snapshots.length > 0 && (
          <Pill variant="info">
            <Camera size={8} />
            {snapshots.length}
          </Pill>
        )}
        {totalCost > 0 && (
          <span className="text-[10px] font-mono text-primary/40">${totalCost.toFixed(4)}</span>
        )}
        <ChevronDown size={12} className={`shrink-0 motion-safe:transition-transform duration-200 ${open ? "rotate-180" : "rotate-0"}`} />
      </button>
      <SmoothReveal open={open}>
        <div className="px-3 pb-3 space-y-2.5">
          {messages.map((msg, i) => (
            <div key={`msg-${i}`} className="flex items-start gap-2">
              <AgentDot shape={msg.avatar_shape} color={msg.avatar_color} size={12} />
              <p className="text-xs text-primary/70 leading-relaxed flex-1">{msg.content}</p>
            </div>
          ))}

          {toolCalls.map((tc) => (
            <ToolCallRow
              key={tc.id}
              call={tc}
              result={toolResults.find((r) => r.id === tc.id)}
            />
          ))}

          {turnProposals.map((prop) => (
            <ProposalRow
              key={prop.id}
              proposal={prop}
              consensus={consensuses.find((c) => c.proposal_id === prop.id)}
              votes={votes.filter((v) => v.proposal_id === prop.id)}
              toolResults={toolResults}
            />
          ))}

          {usageUpdates.length > 0 && (
            <div className="flex flex-wrap gap-2 text-[10px] font-mono text-primary/30">
              <span>{totalInputTokens.toLocaleString()} in</span>
              <span>{totalOutputTokens.toLocaleString()} out</span>
              {usageUpdates[0]?.cache_tokens > 0 && (
                <span>{usageUpdates[0].cache_tokens.toLocaleString()} cached</span>
              )}
              <span>${totalCost.toFixed(4)}</span>
            </div>
          )}
        </div>
      </SmoothReveal>
    </div>
  );
}

TurnBlock.propTypes = {
  turn: PropTypes.number.isRequired,
  events: PropTypes.array.isRequired,
  toolResults: PropTypes.array.isRequired,
  proposals: PropTypes.array.isRequired,
  consensuses: PropTypes.array.isRequired,
  votes: PropTypes.array.isRequired,
};

export default function AgentTrace({ events }) {
  const [isOpen, setIsOpen] = useState(false);

  const toolCallEvents = events.filter((e) => e.type === "tool_call");
  const toolResultEvents = events.filter((e) => e.type === "tool_result");
  const proposalEvents = events.filter((e) => e.type === "proposal");
  const consensusEvents = events.filter((e) => e.type === "consensus");
  const voteEvents = events.filter((e) => e.type === "vote");
  const snapshotEvents = events.filter((e) => e.type === "snapshot_created");
  const usageEvents = events.filter((e) => e.type === "usage_update");
  const turnStartEvents = events.filter((e) => e.type === "turn_start");

  if (toolCallEvents.length === 0 && events.filter((e) => e.type === "agent_thinking").length === 0) return null;

  const turns = turnStartEvents.length > 0
    ? turnStartEvents.map((e) => e.turn)
    : [1];

  const agentThinkingEvents = events.filter((e) => e.type === "agent_thinking");
  const uniqueAgents = agentThinkingEvents.filter(
    (e, i, arr) => arr.findIndex((a) => a.agent_id === e.agent_id) === i
  );

  const totalCost = usageEvents.reduce((sum, u) => sum + (u.total_cost_usd || 0), 0);

  const allEventsWithTurn = events.map((e) => {
    if (e.turn) return e;
    const turnIdx = turnStartEvents.findIndex((t) => {
      const tPos = events.indexOf(t);
      const ePos = events.indexOf(e);
      return tPos > ePos ? false : (turnStartEvents[turnStartEvents.indexOf(t) + 1] ? events.indexOf(turnStartEvents[turnStartEvents.indexOf(t) + 1]) > ePos : true);
    });
    return { ...e, turn: turnIdx >= 0 ? turnStartEvents[turnIdx].turn : 1 };
  });

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-primary/50 hover:text-primary/70 motion-safe:transition-colors cursor-pointer rounded-pill px-1 focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={isOpen}
      >
        <Eye size={12} />
        <span className="font-mono">
          {uniqueAgents.length} agent{uniqueAgents.length !== 1 ? "s" : ""} deliberating
        </span>
        {snapshotEvents.length > 0 && (
          <Pill variant="info">
            <Camera size={8} />
            {snapshotEvents.length} backup{snapshotEvents.length !== 1 ? "s" : ""}
          </Pill>
        )}
        {consensusEvents.length > 0 && (
          <Pill variant="muted">
            {consensusEvents.filter((c) => c.result === "approved").length} approved
            {consensusEvents.filter((c) => c.result === "rejected").length > 0 &&
              `, ${consensusEvents.filter((c) => c.result === "rejected").length} rejected`}
          </Pill>
        )}
        {totalCost > 0 && (
          <Pill variant="muted">${totalCost.toFixed(4)}</Pill>
        )}
        <ChevronDown
          size={12}
          className={`shrink-0 motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
        />
      </button>

      <SmoothReveal open={isOpen} className="mt-3">
        <div className="space-y-2">
          {turns.map((turn) => (
            <TurnBlock
              key={turn}
              turn={turn}
              events={allEventsWithTurn}
              toolResults={toolResultEvents}
              proposals={proposalEvents}
              consensuses={consensusEvents}
              votes={voteEvents}
            />
          ))}
        </div>
      </SmoothReveal>
    </div>
  );
}

AgentTrace.propTypes = {
  events: PropTypes.arrayOf(
    PropTypes.shape({ type: PropTypes.string.isRequired })
  ).isRequired,
};

export { AgentDot };
