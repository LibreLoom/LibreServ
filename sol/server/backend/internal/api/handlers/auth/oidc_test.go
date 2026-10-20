package auth

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/Sol/internal/api/handlers/testutil"
	"gt.plainskill.net/LibreLoom/Sol/internal/auth"
)

// Granting access to an app instance only makes sense for an account that
// exists: the row is the account's permission, and a row for an account that
// is gone grants nobody anything while still taking a slot in the list.
func TestGrantAccessRejectsUnknownUser(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.SeedApp(t, f, "oidc-app")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(f.DB, "oidc-grant-secret", logger)
	h := NewOIDCHandler(f.DB, f.Manager, authSvc, "https://issuer.example.test", logger)

	rec := testutil.CallHandler(
		t,
		http.MethodPost,
		"/access",
		`{"user_id":"ghost"}`,
		map[string]string{"instanceId": "oidc-app"},
		h.GrantAccess,
	)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown user should be refused with 404, got %d: %s", rec.Code, rec.Body.String())
	}

	var count int
	if err := f.DB.QueryRow(
		`SELECT COUNT(*) FROM app_access WHERE user_id = ?`, "ghost",
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("an access row was written for an account that does not exist")
	}

	// The database refuses the row too (app_access points at users), but as a
	// bare constraint error — which is why the handler checks the account
	// first and can answer "no such person" instead of a generic failure.
	if _, err := f.DB.Exec(
		`INSERT INTO app_access (user_id, instance_id) VALUES (?, ?)`, "ghost", "oidc-app",
	); err == nil {
		t.Fatal("expected the foreign key to refuse an access row for an account that does not exist")
	}
}

// The happy path still works, and granting twice keeps one row.
func TestGrantAccessAddsKnownUser(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.SeedApp(t, f, "oidc-app")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(f.DB, "oidc-grant-secret", logger)
	user, err := authSvc.Register(context.Background(), &auth.RegisterRequest{
		Username: "grant-user",
		Password: "VeryStrongPassword123",
		Email:    "grant@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	h := NewOIDCHandler(f.DB, f.Manager, authSvc, "https://issuer.example.test", logger)

	for range 2 {
		rec := testutil.CallHandler(
			t,
			http.MethodPost,
			"/access",
			fmt.Sprintf(`{"user_id":%q}`, user.ID),
			map[string]string{"instanceId": "oidc-app"},
			h.GrantAccess,
		)
		if rec.Code != http.StatusOK {
			t.Fatalf("grant: %d %s", rec.Code, rec.Body.String())
		}
	}

	var count int
	if err := f.DB.QueryRow(
		`SELECT COUNT(*) FROM app_access WHERE user_id = ? AND instance_id = ?`,
		user.ID, "oidc-app",
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected exactly one access row, got %d", count)
	}

	rec := testutil.CallHandler(
		t,
		http.MethodGet,
		"/access",
		"",
		map[string]string{"instanceId": "oidc-app"},
		h.ListAccess,
	)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "grant-user") {
		t.Fatalf("access list: %d %s", rec.Code, rec.Body.String())
	}
}
