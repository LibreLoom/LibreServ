package handlers

import (
	"database/sql"
	"log/slog"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

// BoundDevice summarizes the Luna being set up. Progress can come from that
// Luna's own row; older accounts fall back to the account-wide mirror.
type BoundDevice struct {
	ID          string
	Subdomain   string
	Hostname    string
	Path        string
	Step        string
	HasBound    bool
	HasProgress bool
}

// loadBoundDevice loads deviceID when it belongs to accountID. With no ID it
// picks the oldest bound device, so existing account-wide callers stay
// deterministic when an account owns several Lunas.
func loadBoundDevice(db *database.DB, accountID, deviceID string) BoundDevice {
	var id, sub, path, step sql.NullString
	query := `SELECT d.id, COALESCE(d.subdomain,''), o.path, o.step
FROM devices d LEFT JOIN device_onboarding o ON o.device_id = d.id AND o.account_id = d.account_id
WHERE d.account_id = ? `
	args := []any{accountID}
	if deviceID != "" {
		query += `AND d.id = ? `
		args = append(args, deviceID)
	} else {
		query += `ORDER BY d.created_at, d.id `
	}
	if err := db.QueryRow(query+`LIMIT 1`, args...).Scan(&id, &sub, &path, &step); err != nil {
		return BoundDevice{}
	}
	out := BoundDevice{
		ID: id.String, Subdomain: sub.String,
		Path: path.String, Step: step.String,
		HasBound: id.String != "", HasProgress: path.Valid || step.Valid,
	}
	if sub.String != "" {
		out.Hostname = sub.String + "." + config.C.Server.PublicZone
	}
	return out
}

func deviceBelongsToAccount(db *database.DB, deviceID, accountID string) bool {
	var owner sql.NullString
	if err := db.QueryRow(`SELECT account_id FROM devices WHERE id = ?`, deviceID).Scan(&owner); err != nil {
		return false
	}
	return owner.Valid && owner.String == accountID
}

func countBoundDevices(db *database.DB, accountID string) (int, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM devices WHERE account_id = ?`, accountID).Scan(&n)
	return n, err
}

// saveDeviceOnboarding only writes while the device is unbound or owned by
// accountID, so a concurrent unbind/rebind cannot leave progress with the old
// owner. The same guard covers the insert and the conflict update.
func saveDeviceOnboarding(db *database.DB, deviceID, accountID, path, step string) {
	const owned = `EXISTS (SELECT 1 FROM devices d WHERE d.id = ? AND (d.account_id IS NULL OR d.account_id = '' OR d.account_id = ?))`
	_, _ = db.Exec(`INSERT INTO device_onboarding (device_id, account_id, path, step)
SELECT ?, ?, ?, ? WHERE `+owned+`
ON CONFLICT(device_id) DO UPDATE SET
  account_id = excluded.account_id,
  path = COALESCE(NULLIF(excluded.path, ''), device_onboarding.path),
  step = COALESCE(NULLIF(excluded.step, ''), device_onboarding.step)
WHERE `+owned, deviceID, accountID, path, step, deviceID, accountID, deviceID, accountID)
}

// setOnboardingStep writes progress to the Luna being set up. The account row
// stays a mirror for older clients while it can still describe one Luna; once
// several Lunas are bound, a device-scoped write leaves that mirror alone.
func setOnboardingStep(db *database.DB, accountID, deviceID, path, step string) {
	if deviceID != "" {
		if !deviceBelongsToAccount(db, deviceID, accountID) {
			return
		}
		saveDeviceOnboarding(db, deviceID, accountID, path, step)
		n, err := countBoundDevices(db, accountID)
		if err != nil || n > 1 {
			// Unknown count: do not risk overwriting a mirror that may belong
			// to another Luna.
			return
		}
	} else if dev := loadBoundDevice(db, accountID, ""); dev.ID != "" {
		saveDeviceOnboarding(db, dev.ID, accountID, path, step)
	}
	_, _ = db.Exec(`UPDATE accounts SET onboarding_path = COALESCE(NULLIF(?, ''), onboarding_path), onboarding_step = COALESCE(NULLIF(?, ''), onboarding_step) WHERE id = ?`,
		path, step, accountID)
}

// onboardingFor resolves account-wide legacy progress against one Luna.
func onboardingFor(db *database.DB, acct Account, deviceID string) (BoundDevice, string, string) {
	// Older clients send no device ID. Once checkout has closed setup on the
	// account mirror, an out-of-date per-device row must not reopen it.
	if deviceID == "" && acct.OnboardingStep == "done" {
		return loadBoundDevice(db, acct.ID, ""), acct.OnboardingPath, "done"
	}
	dev := loadBoundDevice(db, acct.ID, deviceID)
	path, step := acct.OnboardingPath, acct.OnboardingStep
	if dev.ID != "" && !dev.HasProgress {
		saveDeviceOnboarding(db, dev.ID, acct.ID, path, step)
	} else if dev.HasProgress {
		if dev.Path != "" {
			path = dev.Path
		}
		if dev.Step != "" {
			step = dev.Step
		}
	}
	resolvedPath, resolvedStep := ResolveOnboarding(path, step, dev)
	if deviceID == "" {
		// Account-wide reads keep the legacy mirror in step with the Luna they
		// describe. A device-scoped read skips this: rewriting the mirror would
		// seed a different Luna on the next account-wide read.
		persistOnboardingIfChanged(db, acct.ID, acct.OnboardingPath, acct.OnboardingStep, resolvedPath, resolvedStep)
	}
	if dev.ID != "" && (resolvedPath != path || resolvedStep != step) {
		saveDeviceOnboarding(db, dev.ID, acct.ID, resolvedPath, resolvedStep)
	}
	return dev, resolvedPath, resolvedStep
}

// finishOnboardingForAccount closes the account-wide legacy mirror when a
// checkout finishes. Payment is still account-wide, so it cannot name one
// Luna: per-Luna progress is closed by that Luna's own setup steps until
// billing is scoped per Luna.
func finishOnboardingForAccount(db *database.DB, accountID string) {
	_, _ = db.Exec(`UPDATE accounts SET onboarding_step = 'done' WHERE id = ?`, accountID)
}

func onboardingDevices(db *database.DB, accountID string) []map[string]any {
	out := make([]map[string]any, 0)
	rows, err := db.Query(`SELECT o.device_id, COALESCE(o.path,''), COALESCE(o.step,''), COALESCE(d.subdomain,'')
FROM device_onboarding o JOIN devices d ON d.id = o.device_id
WHERE o.account_id = ? AND d.account_id = ? ORDER BY d.created_at, d.id`, accountID, accountID)
	if err != nil {
		return out
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, path, step, sub string
		if err := rows.Scan(&id, &path, &step, &sub); err != nil {
			slog.Warn("could not read a Luna's setup progress", "account", accountID, "error", err)
			continue
		}
		host := ""
		if sub != "" {
			host = sub + "." + config.C.Server.PublicZone
		}
		out = append(out, map[string]any{
			"device_id": id, "path": path, "step": step, "hostname": host,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Warn("could not list all Lunas' setup progress", "account", accountID, "error", err)
	}
	return out
}

func isOnboardingCodeStep(step string) bool {
	switch step {
	case "code", "bind", "diy-code", "oss-code":
		return true
	default:
		return false
	}
}

func defaultCodeStep(path string) string {
	if path == "diy" {
		return "diy-code"
	}
	return "code"
}

// ResolveOnboarding derives the step the UI should show from stored progress and device state.
func ResolveOnboarding(path, step string, dev BoundDevice) (resolvedPath, resolvedStep string) {
	resolvedPath = path
	resolvedStep = step
	if resolvedStep == "name" {
		resolvedStep = "domain"
	}
	if resolvedStep == "copies" {
		resolvedStep = "backup"
	}

	if resolvedStep == "done" {
		return resolvedPath, "done"
	}

	if !dev.HasBound {
		switch resolvedStep {
		case "domain", "name", "backup", "copies":
			return resolvedPath, defaultCodeStep(resolvedPath)
		}
		return resolvedPath, resolvedStep
	}

	if isOnboardingCodeStep(resolvedStep) || resolvedStep == "verify" || resolvedStep == "" {
		if dev.Subdomain != "" {
			return resolvedPath, "backup"
		}
		return resolvedPath, "domain"
	}
	if (resolvedStep == "domain" || resolvedStep == "name") && dev.Subdomain != "" {
		return resolvedPath, "backup"
	}
	return resolvedPath, resolvedStep
}

func persistOnboardingIfChanged(db *database.DB, accountID, path, step, resolvedPath, resolvedStep string) {
	if resolvedPath == path && resolvedStep == step {
		return
	}
	_, _ = db.Exec(`UPDATE accounts SET onboarding_path = COALESCE(NULLIF(?, ''), onboarding_path), onboarding_step = ? WHERE id = ?`,
		resolvedPath, resolvedStep, accountID)
}

func onboardingStatusFields(path, step string, dev BoundDevice) map[string]any {
	out := map[string]any{
		"path":             path,
		"step":             step,
		"has_bound_device": dev.HasBound,
		"skip_code_entry":  dev.HasBound,
		"device_id":        "",
		"hostname":         "",
	}
	if dev.HasBound {
		out["device_id"] = dev.ID
		out["hostname"] = dev.Hostname
		if dev.Subdomain != "" {
			out["subdomain"] = dev.Subdomain
		}
	}
	return out
}
