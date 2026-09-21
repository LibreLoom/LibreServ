package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// DomainHandler owns the BYO-domain flow (extracted from the setup wizard so
// it's reachable from Settings after initial setup): validate credentials,
// save the DNS provider config, create wildcard DNS records, request the
// wildcard cert. Supports Cloudflare and RFC 2136 providers.
type DomainHandler struct {
	dnsProviderMgr *network.DNSProviderManager
	acmeManager    *network.ACMEManager
	caddyManager   *network.CaddyManager

	mu        sync.Mutex
	certState certStatus
}

type certStatus struct {
	domain   string
	certDone bool
	certErr  string
}

func NewDomainHandler(
	dnsProviderMgr *network.DNSProviderManager,
	acmeManager *network.ACMEManager,
	caddyManager *network.CaddyManager,
) *DomainHandler {
	return &DomainHandler{
		dnsProviderMgr: dnsProviderMgr,
		acmeManager:    acmeManager,
		caddyManager:   caddyManager,
	}
}

// configureRequest is the BYO-domain configuration payload. provider is
// "cloudflare" or "rfc2136"; rfc2136 adds nameserver/tsig fields.
type configureRequest struct {
	Provider      string `json:"provider"`
	Domain        string `json:"domain"`
	APIToken      string `json:"api_token"`
	Email         string `json:"email"`
	Nameserver    string `json:"nameserver,omitempty"`
	TSIGKeyName   string `json:"tsig_key_name,omitempty"`
	TSIGSecret    string `json:"tsig_secret,omitempty"`
	HMACAlgorithm string `json:"hmac_algorithm,omitempty"`
}

// Configure handles PUT /api/v1/settings/domain — the settings-level
// equivalent of the setup wizard's ApplyDNS.
func (h *DomainHandler) Configure(w http.ResponseWriter, r *http.Request) {
	var req configureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.Provider == "" || req.Domain == "" {
		JSONError(w, http.StatusBadRequest, "Please fill in the provider and domain fields.")
		return
	}
	if req.Provider == "cloudflare" && (req.APIToken == "" || req.Email == "") {
		JSONError(w, http.StatusBadRequest, "Please fill in the access key and email fields.")
		return
	}
	if req.Provider == "rfc2136" && (req.Nameserver == "" || req.TSIGKeyName == "" || req.TSIGSecret == "") {
		JSONError(w, http.StatusBadRequest, "Please fill in the nameserver, key name, and secret fields.")
		return
	}
	if req.Provider != "cloudflare" && req.Provider != "rfc2136" {
		JSONError(w, http.StatusBadRequest, "That DNS provider isn't supported yet.")
		return
	}

	publicIP, err := network.DetectPublicIP(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't determine your server's public address. Please try again.")
		return
	}

	cfg := &network.DNSProviderConfig{
		Provider:      network.ProviderType(req.Provider),
		Domain:        req.Domain,
		APIToken:      req.APIToken,
		Enabled:       true,
		Nameserver:    req.Nameserver,
		TSIGKeyName:   req.TSIGKeyName,
		TSIGSecret:    req.TSIGSecret,
		HMACAlgorithm: req.HMACAlgorithm,
	}

	// Validate credentials first — fail fast with a plain-language error.
	if err := h.dnsProviderMgr.ValidateCredentials(r.Context(), cfg); err != nil {
		slog.Error("DNS credential validation failed", "error", err)
		JSONError(w, http.StatusBadRequest, "We couldn't reach your DNS provider with those details. Please double-check them and try again.")
		return
	}

	if err := h.dnsProviderMgr.SaveConfig(r.Context(), cfg); err != nil {
		slog.Error("Failed to save DNS config", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't save your DNS settings. Please try again.")
		return
	}

	if err := h.dnsProviderMgr.SetupWildcardDNS(r.Context(), cfg, publicIP); err != nil {
		slog.Error("Failed to set up DNS records", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't set up your DNS records. Please try again.")
		return
	}

	// Kick off cert issuance in the background (DNS-01 wildcard).
	h.mu.Lock()
	h.certState = certStatus{domain: req.Domain}
	h.mu.Unlock()

	go func() {
		// Detach from the request context (wildcard issuance can take minutes)
		// and bound it with a timeout so a stuck ACME call cannot leak forever.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
		defer cancel()
		if h.acmeManager == nil {
			h.mu.Lock()
			h.certState.certDone = true
			h.certState.certErr = "certificate service unavailable"
			h.mu.Unlock()
			return
		}
		// Prefer lego-in-podman (the primary ACME path).
		h.acmeManager.WithUsePodman(true)
		err := h.acmeManager.RequestWildcardCert(ctx, req.Domain, req.Email, cfg)
		h.acmeManager.ClearUsePodmanOverride()
		h.mu.Lock()
		h.certState.certDone = true
		if err != nil {
			h.certState.certErr = err.Error()
			slog.Error("wildcard cert request failed", "domain", req.Domain, "error", err)
		} else {
			slog.Info("wildcard cert issued", "domain", req.Domain)
		}
		h.mu.Unlock()
	}()

	JSON(w, http.StatusOK, map[string]string{"status": "configuring", "domain": req.Domain})
}

// Status reports the current domain configuration + cert issuance state.
func (h *DomainHandler) Status(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.dnsProviderMgr.GetConfig(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't read your domain settings.")
		return
	}
	if cfg == nil {
		JSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}

	h.mu.Lock()
	cs := h.certState
	h.mu.Unlock()

	JSON(w, http.StatusOK, map[string]any{
		"configured": true,
		"domain":     cfg.Domain,
		"provider":   cfg.Provider,
		"cert_done":  cs.certDone,
		"cert_error": cs.certErr,
	})
}
