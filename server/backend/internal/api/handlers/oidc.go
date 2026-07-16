package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type OIDCHandler struct {
	db          *database.DB
	appManager  *apps.Manager
	authService *auth.Service
	issuerURL   string
	logger      *slog.Logger
}

// NewOIDCHandler creates a new OIDCHandler.
func NewOIDCHandler(
	db *database.DB,
	appManager *apps.Manager,
	authService *auth.Service,
	issuerURL string,
	logger *slog.Logger,
) *OIDCHandler {
	return &OIDCHandler{
		db:          db,
		appManager:  appManager,
		authService: authService,
		issuerURL:   issuerURL,
		logger:      logger,
	}
}

// GetOIDCClient returns the OIDC client status for an app instance.
func (h *OIDCHandler) GetOIDCClient(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")

	row := h.db.SQL().QueryRow(`
		SELECT client_id, redirect_uris, created_at
		FROM oidc_clients
		WHERE instance_id = ?
	`, instanceID)

	var clientID string
	var redirectURISQL string
	var createdAt string

	err := row.Scan(&clientID, &redirectURISQL, &createdAt)
	if err == sql.ErrNoRows {
		JSON(w, http.StatusOK, map[string]interface{}{
			"configured": false,
			"issuer":     h.issuerURL,
		})
		return
	}
	if err != nil {
		h.logger.Error("Failed to query OIDC client", "error", err, "instance_id", instanceID)
		JSONError(w, http.StatusInternalServerError, "We couldn't load the OIDC configuration. Please try again.")
		return
	}

	var redirectURIs []string
	if err := json.Unmarshal([]byte(redirectURISQL), &redirectURIs); err != nil {
		redirectURIs = nil
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"configured":    true,
		"client_id":     clientID,
		"issuer":        h.issuerURL,
		"redirect_uris": redirectURIs,
		"created_at":    createdAt,
	})
}

// ListAccess lists users with access to an app instance.
func (h *OIDCHandler) ListAccess(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")

	rows, err := h.db.SQL().Query(`
		SELECT aa.user_id, u.username, u.email, aa.granted_at
		FROM app_access aa
		JOIN users u ON u.id = aa.user_id
		WHERE aa.instance_id = ?
		ORDER BY aa.granted_at DESC
	`, instanceID)
	if err != nil {
		h.logger.Error("Failed to query app access", "error", err, "instance_id", instanceID)
		JSONError(w, http.StatusInternalServerError, "We couldn't load the access list. Please try again.")
		return
	}
	defer rows.Close()

	type AccessEntry struct {
		UserID    string `json:"user_id"`
		Username  string `json:"username"`
		Email     string `json:"email"`
		GrantedAt string `json:"granted_at"`
	}

	var entries []AccessEntry
	for rows.Next() {
		var e AccessEntry
		if err := rows.Scan(&e.UserID, &e.Username, &e.Email, &e.GrantedAt); err != nil {
			h.logger.Error("Failed to scan access row", "error", err)
			JSONError(w, http.StatusInternalServerError, "We couldn't load the access list. Please try again.")
			return
		}
		entries = append(entries, e)
	}

	if err := rows.Err(); err != nil {
		h.logger.Error("Error iterating access rows", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't load the access list. Please try again.")
		return
	}

	if entries == nil {
		entries = []AccessEntry{}
	}

	JSON(w, http.StatusOK, entries)
}

// GrantAccessRequest represents the payload for granting user access.
type GrantAccessRequest struct {
	UserID string `json:"user_id"`
}

// GrantAccess grants a user access to an app instance.
func (h *OIDCHandler) GrantAccess(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")

	var req GrantAccessRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "Please provide a user ID.")
		return
	}
	if req.UserID == "" {
		JSONError(w, http.StatusBadRequest, "Please provide a valid user ID.")
		return
	}

	_, err := h.db.SQL().Exec(`
		INSERT OR IGNORE INTO app_access (user_id, instance_id)
		VALUES (?, ?)
	`, req.UserID, instanceID)
	if err != nil {
		h.logger.Error("Failed to grant access", "error", err, "user_id", req.UserID, "instance_id", instanceID)
		JSONError(w, http.StatusInternalServerError, "We couldn't grant access. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "Access granted.",
	})
}

// RevokeAccess revokes a user's access to an app instance.
func (h *OIDCHandler) RevokeAccess(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	userID := chi.URLParam(r, "userId")

	result, err := h.db.SQL().Exec(`
		DELETE FROM app_access WHERE instance_id = ? AND user_id = ?
	`, instanceID, userID)
	if err != nil {
		h.logger.Error("Failed to revoke access", "error", err, "instance_id", instanceID, "user_id", userID)
		JSONError(w, http.StatusInternalServerError, "We couldn't revoke access. Please try again.")
		return
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		JSONError(w, http.StatusNotFound, "We couldn't find that access entry.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "Access revoked.",
	})
}

// ProvisionOIDCClient creates an OIDC client for an app instance and returns
// the plaintext client_id and client_secret. The secret is bcrypt-hashed
// before storage; the plaintext is returned once so the caller can inject
// it into the app's compose template.
func ProvisionOIDCClient(db *database.DB, instanceID, appName string, redirectURIs []string, issuerURL string, logger *slog.Logger) (clientID, clientSecret string, err error) {
	// Generate client_id: <appname>-<randomHex(8)>
	clientID = fmt.Sprintf("%s-%s", appName, randomHex(8))

	// Generate client_secret: 32 random bytes → 64-char hex string
	clientSecret = randomHex(32)

	// Hash the secret with bcrypt
	hashedSecret, err := bcrypt.GenerateFromPassword([]byte(clientSecret), bcrypt.DefaultCost)
	if err != nil {
		return "", "", fmt.Errorf("hashing client secret: %w", err)
	}

	redirectURIsJSON, err := json.Marshal(redirectURIs)
	if err != nil {
		return "", "", fmt.Errorf("marshaling redirect URIs: %w", err)
	}

	_, err = db.SQL().Exec(`
		INSERT OR REPLACE INTO oidc_clients
			(instance_id, client_id, client_secret, redirect_uris, scopes, name)
		VALUES (?, ?, ?, ?, 'openid profile email', ?)
	`, instanceID, clientID, string(hashedSecret), string(redirectURIsJSON), appName)
	if err != nil {
		return "", "", fmt.Errorf("inserting OIDC client: %w", err)
	}

	return clientID, clientSecret, nil
}

// randomHex returns n random bytes as a hex string.
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", 0) // fallback, should never happen
	}
	return fmt.Sprintf("%x", b)[:n*2]
}

// ForwardAuth is the Caddy forward_auth endpoint. Caddy calls this before
// proxying a request to a restricted-access app. If the user is not
// authenticated, it redirects to the login page (302). If authenticated,
// it returns 200 with identity headers that Caddy copies to the backend.
// If authenticated but lacking access, it returns 403.
func (h *OIDCHandler) ForwardAuth(w http.ResponseWriter, r *http.Request) {
	// Extract the access token from cookie (same as middleware.Auth but
	// we don't use the middleware because forward_auth needs to run
	// outside the authenticated route group).
	cookie, err := r.Cookie("libreserv_access")
	if err != nil || cookie.Value == "" {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	claims, err := h.authService.ValidateAccessToken(cookie.Value)
	if err != nil {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	// Check if the original URI (passed by Caddy in the X-Forwarded-Uri
	// header or the original request) maps to a restricted app, and if
	// so, whether this user has access.
	// Caddy forward_auth passes the original request's headers. We use
	// the route's app_id (looked up by the original host) to check access.
	originalHost := r.Header.Get("X-Forwarded-Host")
	if originalHost == "" {
		originalHost = r.Host
	}

	// Look up the route by domain to find the app instance
	route, err := h.getRouteByDomain(originalHost)
	if err == nil && route != nil && route.AppID != "" {
		// Check app_access table
		var count int
		err := h.db.SQL().QueryRow(
			`SELECT COUNT(*) FROM app_access WHERE user_id = ? AND instance_id = ?`,
			claims.UserID, route.AppID,
		).Scan(&count)
		if err != nil || count == 0 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
	}

	// Set identity headers for Caddy to copy to the backend
	w.Header().Set("Remote-User", claims.Username)
	if claims.Role != "" {
		w.Header().Set("Remote-Groups", claims.Role)
	}
	// Fetch email
	user, err := h.authService.GetUserByID(r.Context(), claims.UserID)
	if err == nil && user.Email != "" {
		w.Header().Set("Remote-Email", user.Email)
	}
	w.WriteHeader(http.StatusOK)
}

// getRouteByDomain looks up a Caddy route by its full domain name.
func (h *OIDCHandler) getRouteByDomain(domain string) (*RouteInfo, error) {
	// Try subdomain.domain format
	parts := strings.SplitN(domain, ".", 2)
	var subdomain, baseDomain string
	if len(parts) == 2 {
		subdomain = parts[0]
		baseDomain = parts[1]
	} else {
		baseDomain = domain
	}

	row := h.db.SQL().QueryRow(`
		SELECT id, app_id, restricted_access FROM routes
		WHERE subdomain = ? AND domain = ?
	`, subdomain, baseDomain)

	var ri RouteInfo
	err := row.Scan(&ri.ID, &ri.AppID, &ri.RestrictedAccess)
	if err != nil {
		return nil, err
	}
	return &ri, nil
}

// RouteInfo is a minimal route struct for forward_auth lookups.
type RouteInfo struct {
	ID               string
	AppID            string
	RestrictedAccess bool
}

// ToggleRestrictedAccess enables or disables restricted access for a route.
func (h *OIDCHandler) ToggleRestrictedAccess(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")

	var req struct {
		RestrictedAccess bool `json:"restricted_access"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "Please provide a valid request.")
		return
	}

	// Find the route for this app instance
	route, err := h.appManager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app.")
		return
	}

	// Get route_id from app config
	routeID, ok := route.Config["route_id"].(string)
	if !ok || routeID == "" {
		JSONError(w, http.StatusNotFound, "This app doesn't have a route configured.")
		return
	}

	_, err = h.db.SQL().Exec(`
		UPDATE routes SET restricted_access = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, req.RestrictedAccess, routeID)
	if err != nil {
		h.logger.Error("Failed to toggle restricted access", "error", err, "instance_id", instanceID)
		JSONError(w, http.StatusInternalServerError, "We couldn't update the access setting. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"restricted_access": req.RestrictedAccess,
	})
}

// GetRestrictedAccess returns whether restricted access is enabled for a route.
func (h *OIDCHandler) GetRestrictedAccess(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")

	app, err := h.appManager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSON(w, http.StatusOK, map[string]any{"restricted_access": false})
		return
	}

	routeID, ok := app.Config["route_id"].(string)
	if !ok || routeID == "" {
		JSON(w, http.StatusOK, map[string]any{"restricted_access": false})
		return
	}

	var restricted bool
	err = h.db.SQL().QueryRow(
		`SELECT restricted_access FROM routes WHERE id = ?`, routeID,
	).Scan(&restricted)
	if err != nil {
		JSON(w, http.StatusOK, map[string]any{"restricted_access": false})
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"restricted_access": restricted,
	})
}
