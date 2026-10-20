package api

import (
	"net/http"
	"testing"
)

// Who may open an app is an Admin's job. A plain account must not be able to
// grant itself access, nor read the access list.
//
// The test proves the role check does the refusing: the same request from an
// Admin goes through. Without that, every request would 403 on the setup
// guard and the test would pass even with the role check removed.
func TestOIDCRoutesNeedAdmin(t *testing.T) {
	router, authSvc := testServer(t)

	plainToken, plainCSRF := signInAs(t, authSvc, "user-1", "lin-oidc", "user")
	adminToken, adminCSRF := signInAs(t, authSvc, "admin-2", "ada-oidc", "admin")

	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/apps/app-1/oidc"},
		{http.MethodGet, "/api/v1/apps/app-1/oidc/access"},
		{http.MethodPost, "/api/v1/apps/app-1/oidc/access"},
		{http.MethodDelete, "/api/v1/apps/app-1/oidc/access/user-1"},
		{http.MethodGet, "/api/v1/apps/app-1/oidc/restricted"},
		{http.MethodPut, "/api/v1/apps/app-1/oidc/restricted"},
	}
	for _, tc := range routes {
		rec := do(t, router, tc.method, tc.path, plainToken, plainCSRF, `{"user_id":"user-1"}`)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s as a plain account => %d, want 403", tc.method, tc.path, rec.Code)
		}
	}

	// The same routes, as an Admin: the role check is what refused the
	// plain account, not the setup guard or a missing route.
	for _, tc := range routes {
		rec := do(t, router, tc.method, tc.path, adminToken, adminCSRF, `{"user_id":"user-1"}`)
		if rec.Code == http.StatusForbidden {
			t.Errorf("%s %s as an Admin => %d, want it to pass the role check", tc.method, tc.path, rec.Code)
		}
	}
}

// Restoring a database overwrites the live one, and repository recovery
// keys decrypt every app's backups. Both belong to Admins alone; a plain
// account must not reach them.
func TestBackupRoutesNeedAdmin(t *testing.T) {
	router, authSvc := testServer(t)

	plainToken, plainCSRF := signInAs(t, authSvc, "user-3", "lin-backups", "user")
	adminToken, adminCSRF := signInAs(t, authSvc, "admin-4", "ada-backups", "admin")

	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/backups"},
		{http.MethodPost, "/api/v1/backups"},
		{http.MethodPost, "/api/v1/backups/database/upload-restore"},
		{http.MethodPost, "/api/v1/backups/database/backup-1/restore"},
		{http.MethodGet, "/api/v1/backups/repos/repo-1/recovery-key"},
		{http.MethodPost, "/api/v1/backups/repos"},
		{http.MethodDelete, "/api/v1/backups/backup-1"},
	}
	for _, tc := range routes {
		rec := do(t, router, tc.method, tc.path, plainToken, plainCSRF, `{}`)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s as a plain account => %d, want 403", tc.method, tc.path, rec.Code)
		}
	}
	for _, tc := range routes {
		rec := do(t, router, tc.method, tc.path, adminToken, adminCSRF, `{}`)
		if rec.Code == http.StatusForbidden {
			t.Errorf("%s %s as an Admin => %d, want it to pass the role check", tc.method, tc.path, rec.Code)
		}
	}
}
