package handlers

import (
	"database/sql"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"log/slog"
)

type FactoryResetHandler struct {
	db           *database.DB
	setupService *setup.Service
}

func NewFactoryResetHandler(db *database.DB, setupSvc *setup.Service) *FactoryResetHandler {
	return &FactoryResetHandler{
		db:           db,
		setupService: setupSvc,
	}
}

func (h *FactoryResetHandler) FactoryReset(w http.ResponseWriter, r *http.Request) {
	err := h.db.WithTransaction(r.Context(), func(tx *sql.Tx) error {
		operations := []database.TransactionalOperation{
			{Name: "delete_routes", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM routes")
				return err
			}},
			{Name: "delete_backups", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM backups")
				return err
			}},
			{Name: "delete_backup_schedules", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM backup_schedules")
				return err
			}},
			{Name: "delete_cloud_backup_config", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM cloud_backup_config")
				return err
			}},
			{Name: "delete_dns_provider_configs", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM dns_provider_configs")
				return err
			}},
			{Name: "delete_apps", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM apps")
				return err
			}},
			{Name: "delete_user_security_settings", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM user_security_settings")
				return err
			}},
			{Name: "delete_app_settings", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM app_settings")
				return err
			}},
			{Name: "delete_users", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM users")
				return err
			}},
			{Name: "delete_revoked_tokens", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM revoked_tokens")
				return err
			}},
			{Name: "delete_audit_log", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM audit_log")
				return err
			}},
			{Name: "delete_security_events", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM security_events")
				return err
			}},
			{Name: "delete_failed_login_attempts", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM failed_login_attempts")
				return err
			}},
			{Name: "delete_metrics", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM metrics")
				return err
			}},
			{Name: "delete_health_checks", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM health_checks")
				return err
			}},
			{Name: "delete_updates", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM updates")
				return err
			}},
			{Name: "delete_support_sessions", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM support_sessions")
				return err
			}},
			{Name: "delete_support_audit", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("DELETE FROM support_audit")
				return err
			}},
			{Name: "reset_setup_state_table", Fn: func(tx *sql.Tx) error {
				_, err := tx.Exec("UPDATE setup_state SET status = ?", setup.StatusPending)
				return err
			}},
		}

		for _, op := range operations {
			if err := op.Fn(tx); err != nil {
				slog.Error("factory reset operation failed", "operation", op.Name, "error", err)
				return err
			}
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
