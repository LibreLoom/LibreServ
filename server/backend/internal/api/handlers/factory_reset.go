package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

type FactoryResetHandler struct {
	db           *database.DB
	setupService *setup.Service
	authService  *auth.Service
}

func NewFactoryResetHandler(db *database.DB, setupSvc *setup.Service, authSvc *auth.Service) *FactoryResetHandler {
	return &FactoryResetHandler{
		db:           db,
		setupService: setupSvc,
		authService:  authSvc,
	}
}

func (h *FactoryResetHandler) FactoryReset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm  bool   `json:"confirm"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !req.Confirm {
		JSONError(w, http.StatusBadRequest, "confirmation required")
		return
	}

	// Require password re-authentication to prevent session theft from enabling factory reset
	if req.Password == "" {
		JSONError(w, http.StatusBadRequest, "Please enter your password to confirm factory reset.")
		return
	}

	userID, _ := middleware.GetUserID(r.Context())
	if userID == "" {
		JSONError(w, http.StatusUnauthorized, "Please log in again.")
		return
	}

	user, err := h.authService.GetUserByID(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "Please log in again.")
		return
	}

	if err := auth.VerifyPassword(user.PasswordHash, req.Password); err != nil {
		JSONError(w, http.StatusBadRequest, "Incorrect password. Please try again.")
		return
	}

	err = h.db.WithTransaction(r.Context(), func(tx *sql.Tx) error {
		// Allowlist of tables that can be truncated during factory reset
		// This prevents SQL injection and ensures only expected tables are cleared
		allowedTables := map[string]bool{
			"users":                  true,
			"apps":                   true,
			"backups":                true,
			"backup_schedules":       true,
			"security_events":        true,
			"user_security_settings": true,
			"revoked_tokens":         true,
			"audit_logs":             true,
			"app_update_history":     true,
			"network_routes":         true,
			"acme_jobs":              true,
			"job_queue":              true,
			"settings":               true,
			"notifications":          true,
			"dns_providers":          true,
			"ddns_config":            true,
			"backup_repositories":    true,
			"support_sessions":       true,
			"support_session_audits": true,
		}

		rows, err := tx.Query(`
			SELECT name FROM sqlite_master 
			WHERE type='table' 
			AND name NOT LIKE 'sqlite_%' 
			AND name != 'schema_migrations'
		`)
		if err != nil {
			return err
		}
		defer rows.Close()

		var tables []string
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			if allowedTables[name] {
				tables = append(tables, name)
			} else {
				slog.Debug("Skipping unknown table during factory reset", "table", name)
			}
		}

		for _, table := range tables {
			if _, err := tx.Exec(fmt.Sprintf("DELETE FROM \"%s\"", table)); err != nil {
				slog.Error("factory reset delete failed", "table", table, "error", err)
				return err
			}
		}

		if _, err := tx.Exec("DELETE FROM sqlite_sequence"); err != nil {
			slog.Error("factory reset sqlite_sequence failed", "error", err)
			return err
		}

		if _, err := tx.Exec(`
			UPDATE setup_state 
			SET status = ?, 
			    completed_at = NULL,
			    current_step = 'checking',
			    current_sub_step = NULL,
			    step_data = '{}',
			    progress_updated_at = NULL
			WHERE id = 1
		`, setup.StatusPending); err != nil {
			slog.Error("factory reset setup_state failed", "error", err)
			return err
		}

		return nil
	})

	if err != nil {
		slog.Error("factory reset failed", "error", err)
		JSONError(w, http.StatusInternalServerError, "factory reset failed")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message":  "factory reset complete",
		"redirect": "/setup",
	})
}
