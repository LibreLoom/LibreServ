package agent

import (
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/sandbox"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

// NewSandbox builds the OS-level execution boundary for agent shell commands
// from the agent sandbox configuration. Both the user-facing chat handler and
// the self-healing monitor build their tool registries through this so the
// sandbox is configured consistently.
func NewSandbox(cfg config.SandboxConfig) sandbox.Sandbox {
	return sandbox.New(sandbox.Config{
		Mode:     cfg.Mode,
		Workdirs: cfg.Workdirs,
		Network:  cfg.Network,
	})
}
