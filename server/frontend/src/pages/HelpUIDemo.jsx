/* color-scan: ignore-file - test fixture with intentional avatar colors */
import { useState } from "react";
import { AlertCircle } from "lucide-react";
import Page from "../components/ui/Page.jsx";
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
import ChatEmpty from "../components/help/ChatEmpty.jsx";
import ChatInputBar from "../components/help/ChatInputBar.jsx";
import ConversationItem from "../components/help/ConversationItem.jsx";
import ConversationSidebar from "../components/help/ConversationSidebar.jsx";

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

  return (
    <Page title="Help Components" className="min-h-screen">
      <div className="mt-8 space-y-10 max-w-3xl" data-slot="help-uidemo">

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

        <Section title="ChatEmpty">
          <Card noHeightAnim noPopIn className="min-h-[300px]">
            <ChatEmpty />
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
              onOpenSettings={() => {}}
            />
          </div>
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
            surface="primary"
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
    </Page>
  );
}
