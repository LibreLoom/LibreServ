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
			tables = append(tables, name)
		}

		for _, table := range tables {
			if table == "setup_state" {
				continue
			}
			if _, err := tx.Exec("DELETE FROM " + table); err != nil {
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
