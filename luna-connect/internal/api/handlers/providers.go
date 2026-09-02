package handlers

import (
	"encoding/json"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

// secretCredentialKeys are never returned in full from admin list/create responses.
var secretCredentialKeys = map[string]bool{
	"secret_key":      true,
	"webhook_secret":  true,
	"api_key":         true,
	"application_key": true,
	"api_token":       true,
}

// ProvidersHandler handles admin service provider configuration.
type ProvidersHandler struct {
	db  *database.DB
	svc *providers.Service
}

func NewProvidersHandler(db *database.DB) *ProvidersHandler {
	return &ProvidersHandler{db: db, svc: providers.NewService(db)}
}

type providerRequest struct {
	Service     string            `json:"service"`
	Name        string            `json:"name"`
	Credentials map[string]string `json:"credentials"`
	Settings    map[string]string `json:"settings"`
	Enabled     bool              `json:"enabled"`
}

// publicProvider is the API shape with secrets redacted.
type publicProvider struct {
	ID             string            `json:"id"`
	Service        string            `json:"service"`
	Name           string            `json:"name"`
	Credentials    map[string]string `json:"credentials"`
	Settings       map[string]string `json:"settings"`
	HasCredentials map[string]bool   `json:"has_credentials"`
	Enabled        bool              `json:"enabled"`
	CreatedAt      string            `json:"created_at"`
	UpdatedAt      string            `json:"updated_at"`
}

func redactProvider(p providers.Provider) publicProvider {
	creds := map[string]string{}
	has := map[string]bool{}
	for k, v := range p.Credentials {
		if v == "" {
			continue
		}
		has[k] = true
		if secretCredentialKeys[k] {
			creds[k] = maskSecret(v)
		} else {
			creds[k] = v
		}
	}
	settings := map[string]string{}
	for k, v := range p.Settings {
		settings[k] = v
	}
	return publicProvider{
		ID:             p.ID,
		Service:        p.Service,
		Name:           p.Name,
		Credentials:    creds,
		Settings:       settings,
		HasCredentials: has,
		Enabled:        p.Enabled,
		CreatedAt:      p.CreatedAt,
		UpdatedAt:      p.UpdatedAt,
	}
}

func maskSecret(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if len(v) <= 4 {
		return "••••"
	}
	return "••••" + v[len(v)-4:]
}

// ListProviders returns all service providers (secrets masked) plus config-file fallback status.
func (h *ProvidersHandler) ListProviders(w http.ResponseWriter, r *http.Request) {
	service := r.URL.Query().Get("service")
	list, err := h.svc.List(service)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list connections. Try again.")
		return
	}
	out := make([]publicProvider, 0, len(list))
	for _, p := range list {
		out = append(out, redactProvider(p))
	}
	JSON(w, http.StatusOK, map[string]any{
		"providers":     out,
		"config_status": h.configStatus(),
	})
}

func (h *ProvidersHandler) configStatus() map[string]any {
	status := map[string]any{}

	stripeDB, _ := h.svc.FindEnabled("stripe")
	if stripeDB != nil {
		status["stripe"] = map[string]any{
			"configured":         true,
			"source":             "database",
			"enabled":            stripeDB.Enabled,
			"webhook_ready":      stripeDB.Enabled && strings.HasPrefix(strings.TrimSpace(stripeDB.Credential("webhook_secret", "")), "whsec_"),
			"has_webhook_secret": strings.HasPrefix(strings.TrimSpace(stripeDB.Credential("webhook_secret", "")), "whsec_"),
		}
	} else {
		status["stripe"] = map[string]any{
			"configured":         config.C.Stripe.Ready() || strings.TrimSpace(config.C.Stripe.SecretKey) != "",
			"source":             "config",
			"enabled":            config.C.Stripe.Enabled,
			"webhook_ready":      config.C.Stripe.WebhookReady(),
			"has_webhook_secret": strings.HasPrefix(strings.TrimSpace(config.C.Stripe.WebhookSecret), "whsec_"),
		}
	}

	smtpDB, _ := h.svc.FindEnabled("smtp")
	status["smtp"] = map[string]any{
		"configured": smtpDB != nil && strings.TrimSpace(smtpDB.Credential("api_key", "")) != "",
		"source":     sourceOrEmpty(smtpDB != nil),
		"enabled":    smtpDB != nil && smtpDB.Enabled,
	}

	backupDB, _ := h.svc.FindEnabled("backup")
	status["backup"] = map[string]any{
		"configured": backupDB != nil &&
			strings.TrimSpace(backupDB.Credential("account_id", "")) != "" &&
			strings.TrimSpace(backupDB.Credential("application_key", "")) != "",
		"source":  sourceOrEmpty(backupDB != nil),
		"enabled": backupDB != nil && backupDB.Enabled,
	}

	cfDB, _ := h.svc.FindEnabled("cloudflare")
	if cfDB != nil {
		ready := providers.CloudflareProviderReady(cfDB)
		status["cloudflare"] = map[string]any{
			"configured":  ready,
			"source":      "database",
			"enabled":     cfDB.Enabled && ready,
			"mock_mode":   !ready && config.DevMode(),
			"public_zone": strings.TrimSpace(config.C.Server.PublicZone),
		}
	} else {
		cf := config.C.Cloudflare
		status["cloudflare"] = map[string]any{
			"configured":  cf.Ready(),
			"source":      "config",
			"enabled":     cf.Ready(),
			"mock_mode":   !cf.Ready() && config.DevMode(),
			"public_zone": strings.TrimSpace(config.C.Server.PublicZone),
		}
	}

	return status
}

func sourceOrEmpty(fromDB bool) string {
	if fromDB {
		return "database"
	}
	return ""
}

// CreateProvider creates a new service provider.
func (h *ProvidersHandler) CreateProvider(w http.ResponseWriter, r *http.Request) {
	var req providerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "That request looked wrong. Check the fields and try again.")
		return
	}
	if req.Service == "" || req.Name == "" {
		JSONError(w, http.StatusBadRequest, "Service type and a name are required.")
		return
	}
	if !allowedService(req.Service) {
		JSONError(w, http.StatusBadRequest, "Unknown service type. Use stripe, smtp, backup, or cloudflare.")
		return
	}
	if req.Service == "stripe" {
		if msg := validateStripeFields(req.Credentials, req.Settings); msg != "" {
			JSONError(w, http.StatusBadRequest, msg)
			return
		}
	}

	p, err := h.svc.Create(req.Service, req.Name, req.Credentials, req.Settings, req.Enabled)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not save this connection. Try again.")
		return
	}
	if req.Service == "stripe" {
		_ = providers.ApplyStripeFromDB(h.db)
	}
	if req.Service == "cloudflare" {
		_ = providers.ApplyCloudflareFromDB(h.db)
	}
	JSON(w, http.StatusOK, redactProvider(*p))
}

// UpdateProvider updates an existing service provider.
func (h *ProvidersHandler) UpdateProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req providerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "That request looked wrong. Check the fields and try again.")
		return
	}
	if req.Service == "" || req.Name == "" {
		JSONError(w, http.StatusBadRequest, "Service type and a name are required.")
		return
	}
	if !allowedService(req.Service) {
		JSONError(w, http.StatusBadRequest, "Unknown service type. Use stripe, smtp, backup, or cloudflare.")
		return
	}
	if req.Service == "stripe" {
		if msg := validateStripeFields(req.Credentials, req.Settings); msg != "" {
			JSONError(w, http.StatusBadRequest, msg)
			return
		}
	}

	if err := h.svc.Update(id, req.Service, req.Name, req.Credentials, req.Settings, req.Enabled); err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not update this connection. Try again.")
		return
	}
	if req.Service == "stripe" {
		_ = providers.ApplyStripeFromDB(h.db)
	}
	if req.Service == "cloudflare" {
		_ = providers.ApplyCloudflareFromDB(h.db)
	}
	JSON(w, http.StatusOK, map[string]string{"message": "Connection updated."})
}

// DeleteProvider removes a service provider.
func (h *ProvidersHandler) DeleteProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	existing, _ := h.svc.Get(id)
	if err := h.svc.Delete(id); err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not remove this connection. Try again.")
		return
	}
	if existing != nil {
		switch existing.Service {
		case "stripe":
			_ = providers.ApplyStripeFromDB(h.db)
		case "cloudflare":
			_ = providers.ApplyCloudflareFromDB(h.db)
		}
	}
	JSON(w, http.StatusOK, map[string]string{"message": "Connection removed."})
}

func allowedService(s string) bool {
	switch s {
	case "stripe", "smtp", "backup", "cloudflare":
		return true
	default:
		return false
	}
}

// validateStripeFields rejects Dashboard IDs pasted into the wrong boxes
// (e.g. a price_… value in Secret key), which otherwise become the Stripe API key
// and surface as Cloudflare 502 pages when we used to return Bad Gateway.
func validateStripeFields(creds, settings map[string]string) string {
	if sk := strings.TrimSpace(creds["secret_key"]); sk != "" && !strings.HasPrefix(sk, "sk_") {
		return "Secret key must start with sk_live_ or sk_test_. A price_… ID goes in Storage price ID, not here."
	}
	if wh := strings.TrimSpace(creds["webhook_secret"]); wh != "" && !strings.HasPrefix(wh, "whsec_") {
		return "Webhook secret must start with whsec_."
	}
	if pk := strings.TrimSpace(settings["publishable_key"]); pk != "" && !strings.HasPrefix(pk, "pk_") {
		return "Publishable key must start with pk_live_ or pk_test_."
	}
	if price := strings.TrimSpace(settings["price_id"]); price != "" && !strings.HasPrefix(price, "price_") {
		return "Storage price ID must start with price_."
	}
	if price := strings.TrimSpace(settings["egress_price_id"]); price != "" && !strings.HasPrefix(price, "price_") {
		return "Egress overage price ID must start with price_."
	}
	return ""
}
