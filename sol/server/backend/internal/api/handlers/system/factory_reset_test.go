package system

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/Sol/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/Sol/internal/auth"
	"gt.plainskill.net/LibreLoom/Sol/internal/database"
	"gt.plainskill.net/LibreLoom/Sol/internal/network"
	"gt.plainskill.net/LibreLoom/Sol/internal/setup"
)

func TestFactoryResetTailscaleRecoveryKeepsLiveIdentitySafe(t *testing.T) {
	for _, foreignListener := range []bool{false, true} {
		t.Run(fmt.Sprint("foreign-listener-", foreignListener), func(t *testing.T) {
			dir, err := os.MkdirTemp("", "ts-reset-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(dir) })
			db, err := database.Open(filepath.Join(dir, "test.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err := db.Migrate(); err != nil {
				t.Fatal(err)
			}
			authSvc := auth.NewService(db, "secret", slog.Default())
			user, err := authSvc.Register(context.Background(), &auth.RegisterRequest{Username: "resetadmin", Password: "SuperSecret123", Email: "reset@example.com"})
			if err != nil {
				t.Fatal(err)
			}
			h := NewFactoryResetHandler(db, setup.NewService(db), authSvc)
			t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(dir, "missing-cli"))
			t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
			h.SetTailscale(network.NewTailscaleService(dir, 8080))
			node := filepath.Join(dir, "tailscale")
			if err := os.Mkdir(node, 0700); err != nil {
				t.Fatal(err)
			}
			identity := filepath.Join(node, "tailscaled.state")
			if err := os.WriteFile(identity, []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(node, "enabled"), []byte("1"), 0600); err != nil {
				t.Fatal(err)
			}
			if foreignListener {
				listener, err := net.Listen("unix", filepath.Join(node, "tailscaled.sock"))
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
			} else if err := os.Mkdir(filepath.Join(node, "reset-required"), 0700); err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{"confirm":true,"password":"SuperSecret123"}`))
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserIDContextKey, user.ID))
			rec := httptest.NewRecorder()
			h.FactoryReset(rec, req)
			if foreignListener {
				if rec.Code != http.StatusInternalServerError {
					t.Fatalf("unsafe reset = %d %s", rec.Code, rec.Body.String())
				}
				if _, err := os.Stat(identity); err != nil {
					t.Fatal("live identity was erased", err)
				}
				if _, err := authSvc.GetUserByID(context.Background(), user.ID); err != nil {
					t.Fatal("accounts erased while listener may still be live", err)
				}
			} else {
				if rec.Code != http.StatusOK {
					t.Fatalf("recovery reset = %d %s", rec.Code, rec.Body.String())
				}
				if _, err := os.Stat(identity); !os.IsNotExist(err) {
					t.Fatalf("old identity retained: %v", err)
				}
			}
		})
	}
}

func TestFactoryResetValidation(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	authSvc := auth.NewService(db, "secret", slog.Default())
	setupSvc := setup.NewService(db)
	h := NewFactoryResetHandler(db, setupSvc, authSvc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{}`))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("no confirm: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{"confirm":true}`))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("no password: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{"confirm":true,"password":"x"}`))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no user: %d", rec.Code)
	}

	user, err := authSvc.Register(context.Background(), &auth.RegisterRequest{
		Username: "resetadmin", Password: "SuperSecret123", Email: "r@example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/system/factory-reset", bytes.NewBufferString(`{"confirm":true,"password":"wrong"}`))
	req = req.WithContext(context.WithValue(context.Background(), middleware.UserIDContextKey, user.ID))
	h.FactoryReset(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("wrong password: %d %s", rec.Code, rec.Body.String())
	}
}
