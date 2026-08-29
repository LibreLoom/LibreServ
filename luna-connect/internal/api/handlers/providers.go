package handlers

import (
	"database/sql"
	"encoding/json"
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
}

// ProvidersHandler handles admin service provider configuration.
type ProvidersHandler struct {
	db  *sql.DB
	svc *providers.Service
}

func NewProvidersHandler(db *sql.DB) *ProvidersHandler {
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
		status["stripe"] = map[string]any{"configured": true, "source": "database", "enabled": stripeDB.Enabled}
	} else {
		status["stripe"] = map[string]any{
			"configured": config.C.Stripe.Ready() || strings.TrimSpace(config.C.Stripe.SecretKey) != "",
			"source":     "config",
			"enabled":    config.C.Stripe.Enabled,
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
		JSONError(w, http.StatusBadRequest, "Unknown service type. Use stripe, smtp, or backup.")
		return
	}

	p, err := h.svc.Create(req.Service, req.Name, req.Credentials, req.Settings, req.Enabled)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not save this connection. Try again.")
		return
	}
	if req.Service == "stripe" {
		_ = providers.ApplyStripeFromDB(h.db)
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
		JSONError(w, http.StatusBadRequest, "Unknown service type. Use stripe, smtp, or backup.")
		return
	}

	if err := h.svc.Update(id, req.Service, req.Name, req.Credentials, req.Settings, req.Enabled); err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not update this connection. Try again.")
		return
	}
	if req.Service == "stripe" {
		_ = providers.ApplyStripeFromDB(h.db)
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
	if existing != nil && existing.Service == "stripe" {
		_ = providers.ApplyStripeFromDB(h.db)
	}
	JSON(w, http.StatusOK, map[string]string{"message": "Connection removed."})
}

func allowedService(s string) bool {
	switch s {
	case "stripe", "smtp", "backup":
		return true
	default:
		return false
	}
}
