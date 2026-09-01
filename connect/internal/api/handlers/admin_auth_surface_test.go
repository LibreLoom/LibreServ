package handlers

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

func insertAdminAccount(t *testing.T, db *sql.DB, email, password string) string {
	t.Helper()
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	id := security.GenerateID("admin")
	if _, err := db.Exec(
		`INSERT INTO admin_accounts (id, email, password_hash, name) VALUES ($1, $2, $3, 'Test Admin')`,
		id, email, hash); err != nil {
		t.Fatal(err)
	}
	return id
}

func adminAuthRequest(t *testing.T, h *AdminAuthHandler, adminID, method, path, body string, fn func(http.ResponseWriter, *http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req = req.WithContext(middleware.WithAdminID(req.Context(), adminID))
	w := httptest.NewRecorder()
	fn(w, req)
	return w
}

func TestAdminLoginAndTwoFactor(t *testing.T) {
	db := database.OpenTestDB(t)
	adminID := insertAdminAccount(t, db, "admin@example.com", "very-secure-password")
	h := NewAdminAuthHandler(db)

	for body, want := range map[string]int{
		`{}`: http.StatusBadRequest,
		`{"email":"missing@example.com","password":"very-secure-password"}`: http.StatusUnauthorized,
		`{"email":"admin@example.com","password":"wrong-password"}`:         http.StatusUnauthorized,
		`{"email":"admin@example.com","password":"very-secure-password"}`:   http.StatusOK,
	} {
		got := adminAuthRequest(t, h, "", http.MethodPost, "/admin/login", body, h.Login)
		if got.Code != want {
			t.Fatalf("login %s = %d: %s", body, got.Code, got.Body.String())
		}
	}

	setup := adminAuthRequest(t, h, adminID, http.MethodPost, "/admin/2fa/setup", `{}`, h.Setup2FA)
	if setup.Code != http.StatusOK {
		t.Fatalf("setup 2FA = %d: %s", setup.Code, setup.Body.String())
	}
	var secret string
	if err := db.QueryRow(`SELECT totp_secret FROM admin_accounts WHERE id = $1`, adminID).Scan(&secret); err != nil {
		t.Fatal(err)
	}
	code, err := auth.GenerateTOTPCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invalid := adminAuthRequest(t, h, adminID, http.MethodPost, "/admin/2fa/verify", `{"code":"000000"}`, h.Verify2FA)
	if invalid.Code != http.StatusUnauthorized {
		t.Fatalf("invalid 2FA = %d", invalid.Code)
	}
	verify := adminAuthRequest(t, h, adminID, http.MethodPost, "/admin/2fa/verify", `{"code":"`+code+`"}`, h.Verify2FA)
	if verify.Code != http.StatusOK {
		t.Fatalf("verify 2FA = %d: %s", verify.Code, verify.Body.String())
	}

	challenge := adminAuthRequest(t, h, "", http.MethodPost, "/admin/login",
		`{"email":"admin@example.com","password":"very-secure-password"}`, h.Login)
	if challenge.Code != http.StatusOK || !strings.Contains(challenge.Body.String(), "requires_2fa") {
		t.Fatalf("2FA challenge = %d: %s", challenge.Code, challenge.Body.String())
	}
	login := adminAuthRequest(t, h, "", http.MethodPost, "/admin/login",
		`{"email":"admin@example.com","password":"very-secure-password","totp_code":"`+code+`"}`, h.Login)
	if login.Code != http.StatusOK || !strings.Contains(login.Body.String(), `"has_2fa":true`) {
		t.Fatalf("2FA login = %d: %s", login.Code, login.Body.String())
	}
}

func TestAdminPasswordAndAccountManagement(t *testing.T) {
	db := database.OpenTestDB(t)
	adminID := insertAdminAccount(t, db, "first@example.com", "original-password")
	h := NewAdminAuthHandler(db)

	for body, want := range map[string]int{
		`{}`: http.StatusBadRequest,
		`{"current_password":"original-password","new_password":"short"}`:            http.StatusBadRequest,
		`{"current_password":"wrong-password","new_password":"new-password-123"}`:    http.StatusUnauthorized,
		`{"current_password":"original-password","new_password":"new-password-123"}`: http.StatusOK,
	} {
		got := adminAuthRequest(t, h, adminID, http.MethodPost, "/admin/password", body, h.ChangePassword)
		if got.Code != want {
			t.Fatalf("password %s = %d: %s", body, got.Code, got.Body.String())
		}
	}

	for _, tc := range []struct {
		body string
		want int
	}{
		{`{}`, http.StatusBadRequest},
		{`{"email":"short@example.com","password":"short"}`, http.StatusBadRequest},
		{`{"email":"second@example.com","password":"second-password-123"}`, http.StatusOK},
		{`{"email":"second@example.com","password":"second-password-123"}`, http.StatusConflict},
	} {
		got := adminAuthRequest(t, h, adminID, http.MethodPost, "/admin/admins", tc.body, h.CreateAdmin)
		if got.Code != tc.want {
			t.Fatalf("create admin %s = %d, want %d: %s", tc.body, got.Code, tc.want, got.Body.String())
		}
	}
	list := adminAuthRequest(t, h, adminID, http.MethodGet, "/admin/admins", "", h.ListAdmins)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), "second@example.com") {
		t.Fatalf("list admins = %d: %s", list.Code, list.Body.String())
	}
	var secondID string
	if err := db.QueryRow(`SELECT id FROM admin_accounts WHERE email = 'second@example.com'`).Scan(&secondID); err != nil {
		t.Fatal(err)
	}

	selfReq := chiRequest(http.MethodDelete, "/admin/admins/"+adminID, nil, map[string]string{"adminID": adminID})
	selfReq = selfReq.WithContext(middleware.WithAdminID(selfReq.Context(), adminID))
	selfW := httptest.NewRecorder()
	h.DeleteAdmin(selfW, selfReq)
	if selfW.Code != http.StatusBadRequest {
		t.Fatalf("self delete = %d", selfW.Code)
	}

	deleteReq := chiRequest(http.MethodDelete, "/admin/admins/"+secondID, nil, map[string]string{"adminID": secondID})
	deleteReq = deleteReq.WithContext(middleware.WithAdminID(deleteReq.Context(), adminID))
	deleteW := httptest.NewRecorder()
	h.DeleteAdmin(deleteW, deleteReq)
	if deleteW.Code != http.StatusOK {
		t.Fatalf("delete admin = %d: %s", deleteW.Code, deleteW.Body.String())
	}
}

func TestAdminLoginDisabledAndMissingSetup(t *testing.T) {
	db := database.OpenTestDB(t)
	adminID := insertAdminAccount(t, db, "disabled@example.com", "disabled-password")
	h := NewAdminAuthHandler(db)
	if _, err := db.Exec(`UPDATE admin_accounts SET is_active = FALSE WHERE id = $1`, adminID); err != nil {
		t.Fatal(err)
	}
	login := adminAuthRequest(t, h, "", http.MethodPost, "/admin/login",
		`{"email":"disabled@example.com","password":"disabled-password"}`, h.Login)
	if login.Code != http.StatusForbidden {
		t.Fatalf("disabled login = %d", login.Code)
	}
	verify := adminAuthRequest(t, h, adminID, http.MethodPost, "/admin/2fa/verify", `{"code":"123456"}`, h.Verify2FA)
	if verify.Code != http.StatusBadRequest {
		t.Fatalf("2FA without setup = %d", verify.Code)
	}
}
