// Plain-language labels for technical health-check names (AGENTS.md
// plain-language rule: a non-technical user should not see "caddy_certs_writable").
// Shared by CriticalIssues (dashboard pill) and the About page's System Checks card.
export const CHECK_LABELS = {
  disk_space: "Storage space",
  smtp: "Email delivery",
  caddy_certs_writable: "HTTPS certificate folder",
  caddy_admin_writable: "Web server config folder",
  caddy_config_writable: "Web server config file",
  acme_data_writable: "HTTPS certificate data",
  acme_certs_writable: "HTTPS certificate storage",
  database: "Database",
  runtime: "App runtime",
  api_server: "API server",
  database_path_writable: "Database folder",
  data_path_writable: "Apps folder",
  logs_path_writable: "Logs folder",
};

export function labelFor(name) {
  return (
    CHECK_LABELS[name] ||
    String(name)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}