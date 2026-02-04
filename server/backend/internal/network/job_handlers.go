package network

import (
	"context"
	"fmt"
	"log/slog"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
)

// IssuanceHandler handles certificate issuance jobs
type IssuanceHandler struct {
	manager      *ACMEManager
	caddyManager *CaddyManager
}

// NewIssuanceHandler creates a new issuance handler
func NewIssuanceHandler(manager *ACMEManager, caddyManager *CaddyManager) *IssuanceHandler {
	return &IssuanceHandler{
		manager:      manager,
		caddyManager: caddyManager,
	}
}

// Type returns the job type
func (h *IssuanceHandler) Type() jobqueue.JobType {
	return jobqueue.JobTypeIssuance
}

// MaxRetries returns the default max retries
func (h *IssuanceHandler) MaxRetries() int {
	return jobqueue.DefaultMaxRetriesIssuance
}

// Process executes a certificate issuance job
func (h *IssuanceHandler) Process(ctx context.Context, job *jobqueue.Job, db *database.DB) error {
	logger := slog.Default().With(
		"component", "issuance_handler",
		"job_id", job.ID,
		"domain", job.Domain,
	)

	if h.manager == nil {
		return fmt.Errorf("ACME manager not configured")
	}

	job.AddLog("INFO", "Starting certificate issuance")

	req := ACMERequest{
		Domain: job.Domain,
		Email:  job.Email,
	}

	if job.RouteID != "" {
		req.Backend = job.RouteID
	}

	job.AddLog("INFO", fmt.Sprintf("Requesting certificate for %s", job.Domain))

	if err := h.manager.Issue(ctx, req); err != nil {
		job.AddLog("ERROR", fmt.Sprintf("Issuance failed: %v", err))
		return fmt.Errorf("issue certificate: %w", err)
	}

	job.AddLog("INFO", "Certificate issued successfully")

	// If using external ACME, reload Caddy to pick up the new cert
	if h.manager.ExternalEnabled() && h.caddyManager != nil {
		job.AddLog("INFO", "Reloading Caddy configuration")
		if err := h.caddyManager.ApplyConfig(); err != nil {
			job.AddLog("WARN", fmt.Sprintf("Failed to reload Caddy: %v", err))
			// Don't fail the job - cert is issued, just Caddy reload failed
		} else {
			job.AddLog("INFO", "Caddy configuration reloaded")
		}
	}

	logger.Info("certificate issuance completed", "domain", job.Domain)
	return nil
}

// RenewalHandler handles certificate renewal jobs
type RenewalHandler struct {
	manager      *ACMEManager
	caddyManager *CaddyManager
}

// NewRenewalHandler creates a new renewal handler
func NewRenewalHandler(manager *ACMEManager, caddyManager *CaddyManager) *RenewalHandler {
	return &RenewalHandler{
		manager:      manager,
		caddyManager: caddyManager,
	}
}

// Type returns the job type
func (h *RenewalHandler) Type() jobqueue.JobType {
	return jobqueue.JobTypeRenewal
}

// MaxRetries returns the default max retries
func (h *RenewalHandler) MaxRetries() int {
	return jobqueue.DefaultMaxRetriesRenewal
}

// Process executes a certificate renewal job
func (h *RenewalHandler) Process(ctx context.Context, job *jobqueue.Job, db *database.DB) error {
	logger := slog.Default().With(
		"component", "renewal_handler",
		"job_id", job.ID,
		"domain", job.Domain,
	)

	if h.manager == nil {
		return fmt.Errorf("ACME manager not configured")
	}

	job.AddLog("INFO", "Starting certificate renewal")

	// For now, renewal is similar to issuance - Caddy handles the actual renewal
	// But we track it separately for audit purposes
	req := ACMERequest{
		Domain: job.Domain,
		Email:  job.Email,
	}

	if job.RouteID != "" {
		req.Backend = job.RouteID
	}

	job.AddLog("INFO", fmt.Sprintf("Requesting renewal for %s", job.Domain))

	if err := h.manager.Issue(ctx, req); err != nil {
		job.AddLog("ERROR", fmt.Sprintf("Renewal failed: %v", err))
		return fmt.Errorf("renew certificate: %w", err)
	}

	job.AddLog("INFO", "Certificate renewed successfully")

	// If using external ACME, reload Caddy
	if h.manager.ExternalEnabled() && h.caddyManager != nil {
		job.AddLog("INFO", "Reloading Caddy configuration")
		if err := h.caddyManager.ApplyConfig(); err != nil {
			job.AddLog("WARN", fmt.Sprintf("Failed to reload Caddy: %v", err))
		}
	}

	logger.Info("certificate renewal completed", "domain", job.Domain)
	return nil
}

// ValidationHandler handles domain validation jobs
type ValidationHandler struct{}

// NewValidationHandler creates a new validation handler
func NewValidationHandler() *ValidationHandler {
	return &ValidationHandler{}
}

// Type returns the job type
func (h *ValidationHandler) Type() jobqueue.JobType {
	return jobqueue.JobTypeValidation
}

// MaxRetries returns the default max retries
func (h *ValidationHandler) MaxRetries() int {
	return jobqueue.DefaultMaxRetriesValidation
}

// Process executes a domain validation job
func (h *ValidationHandler) Process(ctx context.Context, job *jobqueue.Job, db *database.DB) error {
	logger := slog.Default().With(
		"component", "validation_handler",
		"job_id", job.ID,
		"domain", job.Domain,
	)

	job.AddLog("INFO", "Starting domain validation")

	// Resolve domain
	job.AddLog("INFO", "Resolving domain DNS")
	result, err := ResolveHostname(ctx, job.Domain, 10)
	if err != nil {
		job.AddLog("ERROR", fmt.Sprintf("DNS resolution failed: %v", err))
		return fmt.Errorf("resolve hostname: %w", err)
	}

	job.AddLog("INFO", fmt.Sprintf("DNS resolved to A: %v, AAAA: %v", result.ARecords, result.AAAARecords))

	// Check common ACME ports
	job.AddLog("INFO", "Testing connectivity on port 80")
	httpResult := ProbeTCP(job.Domain, 80, 10)
	if !httpResult.Reachable {
		job.AddLog("WARN", fmt.Sprintf("Port 80 not accessible: %s", httpResult.Error))
	} else {
		job.AddLog("INFO", "Port 80 is accessible")
	}

	job.AddLog("INFO", "Testing connectivity on port 443")
	httpsResult := ProbeTCP(job.Domain, 443, 10)
	if !httpsResult.Reachable {
		job.AddLog("WARN", fmt.Sprintf("Port 443 not accessible: %s", httpsResult.Error))
	} else {
		job.AddLog("INFO", "Port 443 is accessible")
	}

	// If both ports fail, that's concerning for ACME
	if !httpResult.Reachable && !httpsResult.Reachable {
		job.AddLog("ERROR", "Neither HTTP (80) nor HTTPS (443) ports are accessible")
		return fmt.Errorf("domain validation failed: no ACME challenge ports accessible")
	}

	logger.Info("domain validation completed", "domain", job.Domain)
	return nil
}

// RevocationHandler handles certificate revocation jobs
type RevocationHandler struct {
	manager *ACMEManager
}

// NewRevocationHandler creates a new revocation handler
func NewRevocationHandler(manager *ACMEManager) *RevocationHandler {
	return &RevocationHandler{manager: manager}
}

// Type returns the job type
func (h *RevocationHandler) Type() jobqueue.JobType {
	return jobqueue.JobTypeRevocation
}

// MaxRetries returns the default max retries
func (h *RevocationHandler) MaxRetries() int {
	return jobqueue.DefaultMaxRetriesRevocation
}

// Process executes a certificate revocation job
func (h *RevocationHandler) Process(ctx context.Context, job *jobqueue.Job, db *database.DB) error {
	logger := slog.Default().With(
		"component", "revocation_handler",
		"job_id", job.ID,
		"domain", job.Domain,
	)

	job.AddLog("INFO", "Starting certificate revocation")
	job.AddLog("WARN", "Certificate revocation not yet implemented via job queue")
	job.AddLog("INFO", "Use Caddy admin API or external tools for revocation")

	// TODO: Implement actual revocation when ACME manager supports it
	logger.Warn("certificate revocation not implemented", "domain", job.Domain)

	return fmt.Errorf("certificate revocation not yet implemented")
}
