package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

// SupportCommandHandler executes allowlisted commands for support sessions.
type SupportCommandHandler struct {
	svc *support.Service
}

// NewSupportCommandHandler creates a handler for support command execution.
func NewSupportCommandHandler(svc *support.Service) *SupportCommandHandler {
	return &SupportCommandHandler{svc: svc}
}

type commandRequest struct {
	Code    string   `json:"code"`
	Token   string   `json:"token"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Timeout string   `json:"timeout,omitempty"`
}

var allowedCommands = map[string]bool{
	"docker":     true,
	"df":         true,
	"ls":         true,
	"cat":        true,
	"tail":       true,
	"journalctl": true,
	"ps":         true,
	"top":        false, // disallow by default
}

var commandArgValidators = map[string]func([]string) error{
	"docker":     validateDockerArgs,
	"cat":        validateFileReadArgs,
	"tail":       validateFileReadArgs,
	"ls":         validateLsArgs,
	"df":         validateDfArgs,
	"ps":         validatePsArgs,
	"journalctl": validateJournalctlArgs,
}

// Run executes an allowlisted command for a support session.
func (h *SupportCommandHandler) Run(w http.ResponseWriter, r *http.Request) {
	var req commandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Code == "" || req.Token == "" || req.Command == "" {
		JSONError(w, http.StatusBadRequest, "Support session code, token, and command are all required")
		return
	}
	sess, _, err := h.validateSessionAndPolicy(req.Code, req.Token)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "invalid session")
		return
	}
	if !hasScope(sess.Scopes, "shell-lite") && !hasScope(sess.Scopes, "shell-full") {
		JSONError(w, http.StatusForbidden, "This support session doesn't have permission to run commands")
		return
	}
	// Check if command is explicitly allowed
	if allowed, exists := allowedCommands[req.Command]; !exists || !allowed {
		JSONError(w, http.StatusForbidden, "This command is not permitted for support sessions")
		return
	}

	// Validate arguments using command-specific validators
	if validator, exists := commandArgValidators[req.Command]; exists {
		if err := validator(req.Args); err != nil {
			JSONError(w, http.StatusForbidden, "invalid command arguments")
			return
		}
	}

	// Path containment for file-arg commands
	policy := support.NewDefaultPolicy(nil)
	cfg := config.Get()
	if cfg != nil {
		policy.Allow = append(policy.Allow, cfg.Apps.DataPath, cfg.Logging.Path)
	}
	policy.Allow = append(policy.Allow, support.SafeWorkdir())
	policy.Deny = append(policy.Deny, "/var/lib/docker")
	if err := validateCommandPaths(policy, req.Command, req.Args); err != nil {
		JSONError(w, http.StatusForbidden, "path not allowed")
		return
	}

	timeout := 30 * time.Second
	if req.Timeout != "" {
		if d, err := time.ParseDuration(req.Timeout); err == nil && d > 0 && d < 5*time.Minute {
			timeout = d
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Command, req.Args...)
	// Drop env to reduce leak risk and constrain PATH
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	cmd.Dir = support.SafeWorkdir()
	output, err := cmd.CombinedOutput()
	success := err == nil

	h.svc.LogAudit(r.Context(), &support.AuditEntry{
		SessionID:  sess.ID,
		Actor:      "support-session",
		Action:     "command",
		Target:     strings.Join(append([]string{req.Command}, req.Args...), " "),
		Success:    success,
		Message:    errString(err),
		OccurredAt: time.Now(),
	})

	if ctx.Err() == context.DeadlineExceeded {
		JSONError(w, http.StatusGatewayTimeout, "The command took too long to complete")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Unable to complete the command")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"output": string(output),
	})
}

func (h *SupportCommandHandler) validateSessionAndPolicy(code, token string) (*support.Session, *support.PathPolicy, error) {
	if code == "" || token == "" {
		return nil, nil, errors.New("code and token required")
	}
	sess, err := h.svc.ValidateCode(context.Background(), code, token)
	if err != nil {
		return nil, nil, err
	}
	policy := support.NewDefaultPolicy(nil)
	cfg := config.Get()
	if cfg != nil {
		policy.Allow = append(policy.Allow, cfg.Apps.DataPath, cfg.Logging.Path)
	}
	policy.Deny = append(policy.Deny, "/var/lib/docker")
	return sess, policy, nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func validateDockerArgs(args []string) error {
	if err := support.ValidateDockerArgs(args); err != nil {
		return err
	}
	for _, arg := range args {
		if strings.Contains(arg, "$(") || strings.Contains(arg, "`") || strings.Contains(arg, "|") || strings.Contains(arg, ";") {
			return fmt.Errorf("shell metacharacters not allowed")
		}
	}
	return nil
}

func validateFileReadArgs(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("at least one file path required")
	}
	policy := support.NewDefaultPolicy(nil)
	cfg := config.Get()
	if cfg != nil {
		policy.Allow = append(policy.Allow, cfg.Apps.DataPath, cfg.Logging.Path)
	}
	policy.Deny = append(policy.Deny, "/var/lib/docker")

	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			if arg != "-n" && arg != "-f" && arg != "-F" && arg != "--follow" {
				return fmt.Errorf("option %s not allowed", arg)
			}
			continue
		}
		cleanPath := filepath.Clean(arg)
		if !filepath.IsAbs(cleanPath) {
			return fmt.Errorf("path must be absolute")
		}
		allowed, err := policy.IsAllowed(cleanPath)
		if err != nil || !allowed {
			return fmt.Errorf("path not allowed: %s", arg)
		}
	}
	return nil
}

func validateLsArgs(args []string) error {
	allowedOpts := map[string]bool{
		"-l": true, "-a": true, "-la": true, "-al": true,
		"-h": true, "-lh": true, "-hl": true, "-lah": true,
		"-d": true, "-1": true, "--color=never": true,
	}
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			if !allowedOpts[arg] {
				return fmt.Errorf("option %s not allowed", arg)
			}
		} else {
			cleanPath := filepath.Clean(arg)
			if !filepath.IsAbs(cleanPath) {
				return fmt.Errorf("path must be absolute")
			}
		}
	}
	return nil
}

func validateDfArgs(args []string) error {
	allowedOpts := map[string]bool{
		"-h": true, "-i": true, "-T": true, "-t": true,
		"--total": true, "-H": true,
	}
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			if !allowedOpts[arg] && !strings.HasPrefix(arg, "-t") {
				return fmt.Errorf("option %s not allowed", arg)
			}
		}
	}
	return nil
}

func validatePsArgs(args []string) error {
	allowedOpts := map[string]bool{
		"aux": true, "-ef": true, "-eo": true,
	}
	for _, arg := range args {
		if !allowedOpts[arg] && !strings.HasPrefix(arg, "--") {
			return fmt.Errorf("option %s not allowed", arg)
		}
	}
	return nil
}

func validateJournalctlArgs(args []string) error {
	allowedOpts := map[string]bool{
		"-u": true, "--unit=": true, "-f": true, "--follow": true,
		"-n": true, "--lines=": true, "-e": true, "--since=": true,
		"--until=": true, "-p": true, "--priority=": true,
		"--no-pager": true, "-o": true, "--output=": true,
	}
	for i, arg := range args {
		if strings.HasPrefix(arg, "-u") || strings.HasPrefix(arg, "--unit=") {
			if i+1 >= len(args) {
				return fmt.Errorf("-u requires a unit name")
			}
		}
		if strings.HasPrefix(arg, "-") {
			found := false
			for opt := range allowedOpts {
				if strings.HasPrefix(arg, opt) {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("option %s not allowed", arg)
			}
		}
	}
	return nil
}
