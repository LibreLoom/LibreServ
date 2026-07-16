import { cn } from "@/lib/utils";
import { useState } from "react";
import {
  Check,
  Moon,
  Search,
  Sun,
  User,
} from "lucide-react";
import { useTheme } from "../hooks/useTheme.jsx";
import HeaderCard from "../components/cards/HeaderCard.jsx";
import Card from "../components/cards/Card.jsx";
import BaseCard from "../components/cards/BaseCard.jsx";
import Button from "../components/ui/Button.jsx";
import FormInput from "../components/common/forms/FormInput.jsx";
import Pill from "../components/common/Pill.jsx";
import StatusPill from "../components/common/StatusPill.jsx";
import Alert from "../components/common/Alert.jsx";
import Toggle from "../components/common/Toggle.jsx";
import Dropdown from "../components/common/Dropdown.jsx";
import Table from "../components/common/Table.jsx";
import ModalCard from "../components/cards/ModalCard.jsx";

function Section({ title, children, className = "" }) {
  return (
    <section className={cn("space-y-4", className)}>
      <h2 className="font-mono text-xl font-normal text-secondary">{title}</h2>
      <div className="h-px bg-accent/30" aria-hidden="true" />
      {children}
    </section>
  );
}

function Swatch({ label, value, className = "", children = null }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className={cn("h-16 w-full rounded-large-element ring-1 ring-inset ring-accent/30 flex items-center justify-center", value)}>
        {children}
      </div>
      <div className="text-xs font-mono text-secondary/70">{label}</div>
    </div>
  );
}

const TABLE_COLUMNS = [
  { key: "name", label: "App", align: "left" },
  { key: "status", label: "Status", align: "left", render: (row) => <StatusPill status={row.status} compact /> },
  { key: "uptime", label: "Uptime", align: "right" },
];

const TABLE_DATA = [
  { name: "Nextcloud", status: "running", uptime: "3d 4h", id: 1 },
  { name: "Immich", status: "stopped", uptime: "-", id: 2 },
  { name: "Vaultwarden", status: "error", uptime: "1h", id: 3 },
];

export default function UIDemo() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [demoModalOpen, setDemoModalOpen] = useState(false);
  const [dropdownValue, setDropdownValue] = useState("option-1");
  const [togglePrimary, setTogglePrimary] = useState(true);
  const [toggleSecondary, setToggleSecondary] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [errorInput, setErrorInput] = useState("");

  return (
    <main className="bg-primary text-secondary min-h-screen px-6 md:px-10 pt-6 pb-32" data-slot="uidemo">
      <HeaderCard
        title="Design System"
        bottomContent={
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-primary/80 text-center sm:text-left">
              A reference surface for the standardized LibreServ UI primitives.
              Toggle the theme to verify contrast in both modes.
            </p>
            <div className="flex items-center gap-2 p-1 bg-secondary text-primary rounded-pill">
              <button
                type="button"
                data-slot="theme-toggle"
                onClick={() => setTheme("light")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs font-mono motion-safe:transition-colors no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary",
                  theme === "light" ? "bg-primary text-secondary" : "text-primary/70 hover:text-primary",
                )}
                aria-pressed={theme === "light"}
              >
                <Sun size={14} aria-hidden="true" />
                Light
              </button>
              <button
                type="button"
                data-slot="theme-toggle"
                onClick={() => setTheme("dark")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs font-mono motion-safe:transition-colors no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary",
                  theme === "dark" ? "bg-primary text-secondary" : "text-primary/70 hover:text-primary",
                )}
                aria-pressed={theme === "dark"}
              >
                <Moon size={14} aria-hidden="true" />
                Dark
              </button>
              <button
                type="button"
                data-slot="theme-toggle"
                onClick={() => setTheme("system")}
                className={cn(
                  "px-3 py-1.5 rounded-pill text-xs font-mono motion-safe:transition-colors no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-secondary",
                  theme === "system" ? "bg-primary text-secondary" : "text-primary/70 hover:text-primary",
                )}
                aria-pressed={theme === "system"}
              >
                System
              </button>
            </div>
          </div>
        }
      />

      <div className="mt-10 max-w-6xl mx-auto space-y-16">
        {/* Typography */}
        <Section title="Typography">
          <Card noHeightAnim noPopIn>
            <div className="space-y-4 p-2">
              <div className="font-mono text-4xl font-normal tracking-tight">Display heading (FreeMono)</div>
              <div className="font-mono text-2xl font-normal">Section heading</div>
              <div className="font-mono text-lg font-normal">Subsection heading</div>
              <p className="font-sans text-base leading-relaxed text-secondary/90">
                Body text uses Noto Sans for long-form reading. The design language pairs
                monospace display type with a humanist sans body, keeping the Simplex Mono
                identity while remaining readable.
              </p>
              <p className="font-mono text-sm text-secondary/70">
                Mono captions, labels, and compact data sit one size down.
              </p>
            </div>
          </Card>
        </Section>

        {/* Color tokens */}
        <Section title="Color tokens">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Swatch label="bg-primary (page)" value="bg-primary" />
            <Swatch label="bg-secondary (surface)" value="bg-secondary" />
            <Swatch label="bg-accent" value="bg-accent" />
            <Swatch label="text-success" value="bg-success" />
            <Swatch label="text-warning" value="bg-warning" />
            <Swatch label="text-error" value="bg-error" />
            <Swatch label="text-info" value="bg-info" />
            <Swatch label="Contrast check" value="bg-secondary text-primary font-mono text-sm">
              Aa
            </Swatch>
          </div>
        </Section>

        {/* Buttons */}
        <Section title="Buttons">
          <Card noHeightAnim noPopIn>
            <div className="space-y-8 p-2">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="accent">Accent</Button>
                <Button variant="danger">Danger</Button>
                <Button variant="ghost" surface="secondary">Ghost</Button>
                <Button variant="outline" surface="secondary">Outline</Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button loading smoothResize>Loading</Button>
                <Button disabled>Disabled</Button>
                <Button variant="accent" loading smoothResize>
                  Saving
                </Button>
              </div>

              <Button fullWidth>Full-width primary action</Button>
            </div>
          </Card>
        </Section>

        {/* Form inputs */}
        <Section title="Form inputs">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card noHeightAnim noPopIn>
              <div className="p-2 space-y-2">
                <p className="text-sm text-secondary/70 mb-4">Surface: secondary (inside a card)</p>
                <FormInput
                  label="Username"
                  name="demo-username"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="e.g. admin"
                  icon="username"
                  surface="secondary"
                />
                <FormInput
                  label="Password"
                  name="demo-password"
                  type="password"
                  value="secret"
                  onChange={() => {}}
                  surface="secondary"
                />
                <FormInput
                  label="With error"
                  name="demo-error"
                  value={errorInput}
                  onChange={(e) => setErrorInput(e.target.value)}
                  error={errorInput ? undefined : "This field is required."}
                  surface="secondary"
                />
              </div>
            </Card>

            <div className="bg-primary text-secondary rounded-large-element p-6 ring-1 ring-inset ring-accent/30">
              <p className="text-sm text-secondary/70 mb-4">Surface: primary (page background)</p>
              <FormInput
                label="Email"
                name="demo-email"
                type="email"
                value=""
                onChange={() => {}}
                placeholder="your@email.com"
                icon="email"
                surface="primary"
              />
              <FormInput
                label="Search"
                name="demo-search"
                value=""
                onChange={() => {}}
                placeholder="Search..."
                icon="username"
                surface="primary"
              />
            </div>
          </div>
        </Section>

        {/* Cards */}
        <Section title="Cards">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card title="Titled card" icon={Check}>
              <p className="text-sm text-primary/80">
                Cards use the secondary surface with primary text, rounded-large-element corners,
                and a subtle pop-in animation.
              </p>
            </Card>

            <BaseCard
              icon={User}
              title="BaseCard"
              subtitle="For metric summaries"
            >
              <div className="font-mono text-3xl text-primary">99.9%</div>
              <div className="text-sm text-primary/70 mt-1">Availability</div>
            </BaseCard>

            <Card noHeightAnim noPopIn className="flex flex-col justify-center">
              <div className="text-center space-y-2">
                <div className="font-mono text-lg text-primary">Static card</div>
                <p className="text-sm text-primary/70">No height animation, no pop-in.</p>
              </div>
            </Card>
          </div>
        </Section>

        {/* Pills & badges */}
        <Section title="Pills & badges">
          <Card noHeightAnim noPopIn>
            <div className="p-2 space-y-6">
              <div>
                <p className="text-sm text-secondary/70 mb-3 font-mono">Pill</p>
                <div className="flex flex-wrap gap-2">
                  <Pill variant="default">Default</Pill>
                  <Pill variant="muted">Muted</Pill>
                  <Pill variant="accent">Accent</Pill>
                  <Pill variant="success">Success</Pill>
                  <Pill variant="warning">Warning</Pill>
                  <Pill variant="error">Error</Pill>
                  <Pill variant="info">Info</Pill>
                </div>
              </div>

              <div>
                <p className="text-sm text-secondary/70 mb-3 font-mono">Pill (compact)</p>
                <div className="flex flex-wrap gap-2">
                  <Pill variant="default">Default</Pill>
                  <Pill variant="accent">Accent</Pill>
                  <Pill variant="success">Success</Pill>
                  <Pill variant="warning">Warning</Pill>
                  <Pill variant="error">Error</Pill>
                  <Pill variant="info">Info</Pill>
                </div>
              </div>

              <div>
                <p className="text-sm text-secondary/70 mb-3 font-mono">StatusPill</p>
                <div className="flex flex-wrap gap-2">
                  <StatusPill status="running" />
                  <StatusPill status="stopped" />
                  <StatusPill status="error" />
                  <StatusPill status="unknown" />
                  <StatusPill status="running" compact />
                </div>
              </div>
            </div>
          </Card>
        </Section>

        {/* Alerts */}
        <Section title="Alerts">
          <Card noHeightAnim noPopIn>
            <div className="p-2 grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Alert variant="error" message="Could not connect to the email provider." />
              <Alert variant="warning" message="Storage is above 85% capacity." />
              <Alert variant="info" message="A new update is available." />
              <Alert variant="success" message="Backup completed successfully." />
            </div>
          </Card>
        </Section>

        {/* Toggles */}
        <Section title="Toggles">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card noHeightAnim noPopIn>
              <div className="p-2 space-y-4">
                <Toggle
                  label="Notifications"
                  description="Send email alerts for system events"
                  checked={toggleSecondary}
                  onChange={setToggleSecondary}
                  surface="secondary"
                />
                <Toggle
                  label="Auto-update"
                  description="Install patch releases automatically"
                  checked={!toggleSecondary}
                  onChange={(v) => setToggleSecondary(!v)}
                  surface="secondary"
                  disabled
                />
              </div>
            </Card>

            <div className="bg-primary text-secondary rounded-large-element p-6 ring-1 ring-inset ring-accent/30 space-y-4">
              <Toggle
                label="Dark mode"
                description="Use the dark color scheme"
                checked={resolvedTheme === "dark"}
                onChange={(v) => setTheme(v ? "dark" : "light")}
                surface="primary"
              />
              <Toggle
                label="Analytics"
                description="Share anonymous usage data"
                checked={togglePrimary}
                onChange={setTogglePrimary}
                surface="primary"
              />
            </div>
          </div>
        </Section>

        {/* Dropdown */}
        <Section title="Dropdown">
          <Card noHeightAnim noPopIn>
            <div className="p-2 flex flex-wrap items-end gap-6">
              <Dropdown
                label="Standard"
                value={dropdownValue}
                onChange={setDropdownValue}
                options={[
                  { value: "option-1", label: "Option one" },
                  { value: "option-2", label: "Option two" },
                  { value: "option-3", label: "Option three" },
                ]}
              />
              <Dropdown
                ghost
                value={dropdownValue}
                onChange={setDropdownValue}
                placeholder="Ghost variant"
                options={[
                  { value: "option-1", label: "Option one" },
                  { value: "option-2", label: "Option two" },
                ]}
              />
              <div className="w-48">
                <Dropdown
                  fullWidth
                  label="Full width"
                  value={dropdownValue}
                  onChange={setDropdownValue}
                  options={[
                    { value: "option-1", label: "Option one" },
                    { value: "option-2", label: "Option two" },
                  ]}
                />
              </div>
            </div>
          </Card>
        </Section>

        {/* Table */}
        <Section title="Table">
          <Card noHeightAnim noPopIn>
            <div className="p-2">
              <Table columns={TABLE_COLUMNS} data={TABLE_DATA} rowKey="id" />
            </div>
          </Card>
        </Section>

        {/* Modal */}
        <Section title="Modal">
          <Card noHeightAnim noPopIn>
            <div className="p-2">
              <Button onClick={() => setDemoModalOpen(true)}>Open ModalCard</Button>
            </div>
          </Card>
          {demoModalOpen && (
            <ModalCard
              title="Example modal"
              onClose={() => setDemoModalOpen(false)}
              footer={
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setDemoModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => setDemoModalOpen(false)}>Confirm</Button>
                </div>
              }
            >
              <p className="text-primary/80 text-sm">
                ModalCard uses a portal, traps focus, and animates in and out. It layers
                on top of the page with a backdrop blur.
              </p>
            </ModalCard>
          )}
        </Section>
      </div>
    </main>
  );
}