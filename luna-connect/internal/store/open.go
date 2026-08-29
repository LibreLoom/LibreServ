package store

import (
	"database/sql"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

// Open picks the object store from backup.driver and Admin → Connections.
// driver "auto" uses B2 when an enabled backup provider with keys exists
// (checked per request, so Connections updates apply without restart).
func Open(db *sql.DB, driver, dataDir string) (Store, string, error) {
	driver = strings.ToLower(strings.TrimSpace(driver))
	if driver == "" {
		driver = "auto"
	}

	local, err := NewLocal(dataDir)
	if err != nil {
		return nil, "", err
	}

	switch driver {
	case "local":
		slog.Info("backup object store", "driver", "local")
		return local, "local", nil
	case "b2":
		b2, err := NewB2(db, filepath.Join(dataDir, "b2-tmp"))
		if err != nil {
			return nil, "", err
		}
		slog.Info("backup object store", "driver", "b2")
		return b2, "b2", nil
	case "auto":
		b2, err := NewB2(db, filepath.Join(dataDir, "b2-tmp"))
		if err != nil {
			return nil, "", err
		}
		prov, err := providers.NewService(db).FindEnabled("backup")
		if err != nil {
			return nil, "", err
		}
		ready := prov != nil &&
			strings.TrimSpace(prov.Credential("account_id", "")) != "" &&
			strings.TrimSpace(prov.Credential("application_key", "")) != ""
		name := "auto(local)"
		if ready {
			name = "auto(b2)"
		}
		slog.Info("backup object store", "driver", name)
		return &Auto{DB: db, Local: local, B2: b2}, "auto", nil
	default:
		return nil, "", fmt.Errorf("unknown backup.driver %q (use auto, b2, or local)", driver)
	}
}
