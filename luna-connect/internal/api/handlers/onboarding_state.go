package handlers

import (
	"database/sql"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// BoundDevice summarizes the Luna linked to an account for onboarding resume.
type BoundDevice struct {
	ID        string
	Subdomain string
	Hostname  string
	HasBound  bool
}

func loadBoundDevice(db *sql.DB, accountID string) BoundDevice {
	var id, sub string
	err := db.QueryRow(`SELECT id, COALESCE(subdomain,'') FROM devices WHERE account_id = ? LIMIT 1`, accountID).
		Scan(&id, &sub)
	if err != nil {
		return BoundDevice{}
	}
	out := BoundDevice{ID: id, Subdomain: sub, HasBound: id != ""}
	if sub != "" {
		out.Hostname = sub + "." + config.C.Server.PublicZone
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

func persistOnboardingIfChanged(db *sql.DB, accountID, path, step, resolvedPath, resolvedStep string) {
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
