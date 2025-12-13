package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

// SupportCommandHandler executes allowlisted commands for support sessions.
type SupportCommandHandler struct {
	svc *support.Service
}

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

func (h *SupportCommandHandler) Run(w http.ResponseWriter, r *http.Request) {
	var req commandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Code == "" || req.Token == "" || req.Command == "" {
		JSONError(w, http.StatusBadRequest, "code, token, command required")
		return
	}
	sess, _, err := h.validateSessionAndPolicy(req.Code, req.Token)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, err.Error())
		return
	}
	if !hasScope(sess.Scopes, "shell-lite") && !hasScope(sess.Scopes, "shell-full") {
		JSONError(w, http.StatusForbidden, "scope shell-lite/full required")
		return
	}
	if !allowedCommands[req.Command] {
		JSONError(w, http.StatusForbidden, "command not allowed")
		return
	}
	if req.Command == "docker" {
		if err := support.ValidateDockerArgs(req.Args); err != nil {
			JSONError(w, http.StatusForbidden, err.Error())
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
		JSONError(w, http.StatusForbidden, err.Error())
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
		JSONError(w, http.StatusGatewayTimeout, "command timed out")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "command failed: "+err.Error())
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
