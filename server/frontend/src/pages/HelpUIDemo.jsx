/* color-scan: ignore-file - test fixture with intentional avatar colors */
import { useState } from "react";
import { AlertCircle } from "lucide-react";
import HeaderCard from "../components/cards/HeaderCard.jsx";
import Card from "../components/cards/Card.jsx";
import Button from "../components/ui/Button.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import Alert from "../components/common/Alert.jsx";
import Pill from "../components/common/Pill.jsx";
import SegmentedControl from "../components/common/SegmentedControl.jsx";
import Dropdown from "../components/common/Dropdown.jsx";
import ChatMessage from "../components/help/ChatMessage.jsx";
import ChatPermissionPrompt from "../components/help/ChatPermissionPrompt.jsx";
import ChatStreamingIndicator from "../components/help/ChatStreamingIndicator.jsx";
import ChatCreditBar from "../components/help/ChatCreditBar.jsx";
import ChatEmpty from "../components/help/ChatEmpty.jsx";
import ChatInputBar from "../components/help/ChatInputBar.jsx";
import ChatHeader from "../components/help/ChatHeader.jsx";
import ConversationItem from "../components/help/ConversationItem.jsx";
import ConversationSidebar from "../components/help/ConversationSidebar.jsx";
import AgentTrace from "../components/agent/AgentTrace.jsx";

const MOCK_TRACE_EVENTS = [
  { type: "turn_start", turn: 1 },
  { type: "agent_thinking", agent_id: "researcher", avatar_shape: "diamond", avatar_color: "#FF6B35", model: "route/mimo-v2.5-pro", turn: 1 },
  { type: "agent_thinking", agent_id: "reviewer", avatar_shape: "circle", avatar_color: "#4ECDC4", model: "route/kimi-k2.6", turn: 1 },
  { type: "agent_message", agent_id: "researcher", avatar_shape: "diamond", avatar_color: "#FF6B35", content: "Checking container status and disk usage...", turn: 1 },
  { type: "tool_call", id: "tc-1", name: "podman_inspect", agent_id: "researcher", arguments: "{\"container\":\"nextcloud\"}", turn: 1 },
  { type: "tool_result", id: "tc-1", content: "Container nextcloud: status=unhealthy, disk=98%", is_error: false, turn: 1 },
  { type: "tool_call", id: "tc-2", name: "podman_restart", agent_id: "researcher", arguments: "{\"container\":\"nextcloud\"}", turn: 1 },
  { type: "usage_update", turn_cost_usd: 0.0234, total_cost_usd: 0.0234, input_tokens: 1520, output_tokens: 340, cache_tokens: 800, remaining_usd: 9.98, turn: 1 },
  { type: "proposal", id: "prop-1", agent_id: "researcher", proposal_type: "write", tool_calls: [{ id: "tc-2", name: "podman_restart", arguments: "{\"container\":\"nextcloud\"}", agent_id: "researcher" }], turn: 1 },
  { type: "vote", proposal_id: "prop-1", agent_id: "reviewer", avatar_shape: "circle", avatar_color: "#4ECDC4", decision: "approve", reason: "Safe to restart — container is unhealthy.", turn: 1 },
  { type: "consensus", proposal_id: "prop-1", result: "approved", votes: [{ agent_id: "reviewer", decision: "approve", reason: "Safe to restart." }], turn: 1 },
  { type: "snapshot_created", snapshot_id: "snap-1", tool_call_id: "tc-2", turn: 1 },
  { type: "tool_result", id: "tc-2", content: "Container nextcloud restarted successfully. Status: healthy.", is_error: false, turn: 1 },
  { type: "turn_start", turn: 2 },
  { type: "agent_thinking", agent_id: "researcher", avatar_shape: "diamond", avatar_color: "#FF6B35", model: "route/mimo-v2.5-pro", turn: 2 },
  { type: "agent_thinking", agent_id: "reviewer", avatar_shape: "circle", avatar_color: "#4ECDC4", model: "route/kimi-k2.6", turn: 2 },
  { type: "agent_message", agent_id: "researcher", avatar_shape: "diamond", avatar_color: "#FF6B35", content: "Nextcloud is back up and healthy. I'd recommend setting up automatic cleanup of old file versions.", turn: 2 },
  { type: "usage_update", turn_cost_usd: 0.0156, total_cost_usd: 0.0390, input_tokens: 2100, output_tokens: 280, cache_tokens: 1200, remaining_usd: 9.96, turn: 2 },
  { type: "proposal", id: "prop-2", agent_id: "researcher", proposal_type: "final_response", response: "Nextcloud has been restarted and is now healthy. I'd recommend setting up automatic cleanup of old file versions to prevent disk space issues in the future.", turn: 2 },
  { type: "vote", proposal_id: "prop-2", agent_id: "reviewer", avatar_shape: "circle", avatar_color: "#4ECDC4", decision: "approve", reason: "Accurate and helpful response.", turn: 2 },
  { type: "consensus", proposal_id: "prop-2", result: "approved", votes: [{ agent_id: "reviewer", decision: "approve", reason: "Accurate and helpful." }], turn: 2 },
  { type: "done", reason: "complete" },
];

const MOCK_CONVERSATIONS = [
  { id: "1", title: "Nextcloud not responding", date: "May 25, 2026", status: "active" },
  { id: "2", title: "SearXNG update failed", date: "May 24, 2026", status: "resolved" },
  { id: "3", title: "Ollama out of memory", date: "May 23, 2026", status: "resolved" },
  { id: "4", title: "Backup schedule broken", date: "May 22, 2026", status: "error" },
];

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h3 className="font-mono text-secondary text-sm border-b border-secondary/10 pb-2">{title}</h3>
      {children}
    </section>
  );
}

export default function HelpUIDemo() {
  const [model, setModel] = useState("route/mimo-v2.5-pro");
  const [permMode, setPermMode] = useState("standard");
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <main className="bg-primary text-secondary px-8 pt-5 pb-32 min-h-screen">
      <HeaderCard title="Help Components" />

      <div className="mt-8 space-y-10 max-w-3xl">

        <Section title="EmptyState — Not Configured">
          <Card noHeightAnim noPopIn>
            <EmptyState
              icon={AlertCircle}
              title="AI Support Not Configured"
              description="Set up your AI provider in Settings to enable the help assistant. You need a subscription or your own API key."
              action={
                <Button variant="primary" size="md">Set up AI Support</Button>
              }
            />
          </Card>
        </Section>

        <Section title="ChatHeader">
          <Card noHeightAnim noPopIn padding={false}>
            <ChatHeader
              model={model}
              onModelChange={setModel}
              permissionMode={permMode}
              onPermissionModeChange={setPermMode}
              creditUsed={2.5}
              creditCap={10}
              planName="Basic"
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
              onOpenSettings={() => {}}
            />
          </Card>
        </Section>

        <Section title="ChatMessage">
          <Card noHeightAnim noPopIn>
            <div className="space-y-3 p-5">
              <ChatMessage role="user" content="My Nextcloud is not responding. Can you check what's going on?" />
              <ChatMessage role="assistant" content="I'll check the Nextcloud container status and logs for you right now." />
              <ChatMessage role="user" content="Yes, please restart it." />
              <ChatMessage role="assistant" content="Done. Nextcloud is back up and responding normally. I'd recommend setting up automatic cleanup of old file versions — want me to walk you through that?" />
            </div>
          </Card>
        </Section>

        <Section title="ChatPermissionPrompt">
          <div className="bg-secondary/50 rounded-large-element p-5">
            <ChatPermissionPrompt
              toolName="podman_restart"
              reason="Restarting the Nextcloud container to restore service"
              onAllow={() => {}}
              onDeny={() => {}}
            />
          </div>
        </Section>

        <Section title="ChatStreamingIndicator">
          <div className="bg-secondary/50 rounded-large-element p-5">
            <ChatStreamingIndicator />
          </div>
        </Section>

        <Section title="ChatCreditBar">
          <div className="space-y-3">
            <div className="bg-secondary/50 rounded-large-element p-3">
              <ChatCreditBar used={2.5} cap={10} planName="Basic" />
            </div>
            <div className="bg-secondary/50 rounded-large-element p-3">
              <ChatCreditBar used={8.5} cap={10} planName="Basic" />
            </div>
            <div className="bg-secondary/50 rounded-large-element p-3">
              <ChatCreditBar used={10} cap={10} planName="Basic" />
            </div>
          </div>
        </Section>

        <Section title="ChatEmpty">
          <Card noHeightAnim noPopIn>
            <ChatEmpty onSuggestionClick={() => {}} />
          </Card>
        </Section>

        <Section title="ChatInputBar">
          <Card noHeightAnim noPopIn padding={false} className="max-w-lg">
            <ChatInputBar
              value={input}
              onChange={setInput}
              onSend={() => { setInput(""); }}
              onStop={() => {}}
              isStreaming={false}
            />
          </Card>
          <div className="mt-3" />
          <p className="text-xs text-secondary/40 font-mono mb-2">Streaming state:</p>
          <Card noHeightAnim noPopIn padding={false} className="max-w-lg">
            <ChatInputBar
              value="Check my Nextcloud"
              onChange={() => {}}
              onSend={() => {}}
              onStop={() => {}}
              isStreaming={true}
            />
          </Card>
        </Section>

        <Section title="ConversationItem">
          <div className="space-y-1 max-w-sm bg-secondary/50 rounded-large-element p-3">
            <ConversationItem title="Nextcloud not responding" date="May 25, 2026" status="active" isActive={true} onClick={() => {}} />
            <ConversationItem title="SearXNG update failed" date="May 24, 2026" status="resolved" isActive={false} onClick={() => {}} />
            <ConversationItem title="Ollama out of memory" date="May 23, 2026" status="error" isActive={false} onClick={() => {}} />
          </div>
        </Section>

        <Section title="ConversationSidebar">
          <div className="max-w-xs">
            <ConversationSidebar
              conversations={MOCK_CONVERSATIONS}
              activeId="1"
              onSelect={() => {}}
              onNewChat={() => {}}
            />
          </div>
        </Section>

        <Section title="AgentTrace">
          <Card noHeightAnim noPopIn>
            <AgentTrace events={MOCK_TRACE_EVENTS} />
          </Card>
        </Section>

        <Section title="SegmentedControl (Permission Mode)">
          <SegmentedControl
            options={[
              { value: "standard", label: "Standard" },
              { value: "approve_every_call", label: "Approve Each" },
            ]}
            value={permMode}
            onChange={setPermMode}
          />
        </Section>

        <Section title="Dropdown (Model Selector)">
          <Dropdown
            label="Model"
            value={model}
            onChange={setModel}
            options={[
              { value: "route/mimo-v2.5-pro", label: "Mimo v2.5 Pro" },
              { value: "route/kimi-k2.6", label: "Kimi K2.6" },
              { value: "route/deepseek-r1", label: "DeepSeek R1" },
            ]}
            bg="primary"
          />
        </Section>

        <Section title="Pill (Status Variants)">
          <div className="flex flex-wrap gap-2">
            <Pill variant="default">Default</Pill>
            <Pill variant="muted">Muted</Pill>
            <Pill variant="success">Active</Pill>
            <Pill variant="warning">Warning</Pill>
            <Pill variant="error">Error</Pill>
            <Pill variant="info">Info</Pill>
          </div>
        </Section>

        <Section title="Alert (Variants)">
          <div className="space-y-2 max-w-lg">
            <Alert variant="error" message="Something went wrong connecting to the AI service." />
            <Alert variant="warning" message="You have used 85% of your monthly credit." />
            <Alert variant="info" message="Your plan renews on June 1st." />
            <Alert variant="success" message="AI Support is connected and ready." />
          </div>
        </Section>

      </div>
    </main>
  );
}
