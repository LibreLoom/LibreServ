package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func newTestUsersHandler(t *testing.T) (*UsersHandler, context.Context) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "secret", slog.Default())
	return NewUsersHandler(svc), context.Background()
}

func TestUsersCRUD(t *testing.T) {
	h, ctx := newTestUsersHandler(t)

	// create user
	body := `{"username":"user1","password":"Password1234","role":"user"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users", bytes.NewBufferString(body))
	h.CreateUser(rec, req.WithContext(ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status %d", rec.Code)
	}

	// list users
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/users", nil)
	h.ListUsers(rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status %d", rec.Code)
	}
	var list struct {
		Data       []map[string]interface{} `json:"data"`
		Pagination struct {
			TotalItems int64 `json:"total_items"`
		} `json:"pagination"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if list.Pagination.TotalItems != 1 {
		t.Fatalf("expected 1 user, got %d", list.Pagination.TotalItems)
	}
	id, _ := list.Data[0]["id"].(string)

	// get user
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/users/"+id, nil).WithContext(ctx)
	req = withChiURLParam(req, "userID", id)
	h.GetUser(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status %d", rec.Code)
	}

	// update user
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/v1/users/"+id, bytes.NewBufferString(`{"role":"admin"}`)).WithContext(ctx)
	req = withChiURLParam(req, "userID", id)
	h.UpdateUser(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status %d", rec.Code)
	}

	// delete user (should fail - this is the last admin)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/users/"+id, nil).WithContext(ctx)
	req = withChiURLParam(req, "userID", id)
	h.DeleteUser(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected delete last admin to fail with 400, got %d", rec.Code)
	}
}

func TestDeleteLastAdminProtection(t *testing.T) {
	h, ctx := newTestUsersHandler(t)

	// Create two admin users with unique emails
	body1 := `{"username":"admin1","password":"Password1234","role":"admin","email":"admin1@test.com"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users", bytes.NewBufferString(body1))
	h.CreateUser(rec, req.WithContext(ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create admin1 status %d", rec.Code)
	}

	body2 := `{"username":"admin2","password":"Password1234","role":"admin","email":"admin2@test.com"}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users", bytes.NewBufferString(body2))
	h.CreateUser(rec, req.WithContext(ctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create admin2 status %d", rec.Code)
	}

	// List to get IDs
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/users", nil)
	h.ListUsers(rec, req.WithContext(ctx))
	var list struct {
		Data []map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Data) != 2 {
		t.Fatalf("expected 2 users, got %d", len(list.Data))
	}

	id1 := list.Data[0]["id"].(string)
	id2 := list.Data[1]["id"].(string)

	// Delete first admin (should succeed - not the last admin)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/users/"+id1, nil).WithContext(ctx)
	req = withChiURLParam(req, "userID", id1)
	h.DeleteUser(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete first admin status %d", rec.Code)
	}

	// Delete second admin (should fail - this is now the last admin)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/users/"+id2, nil).WithContext(ctx)
	req = withChiURLParam(req, "userID", id2)
	h.DeleteUser(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected delete last admin to fail with 400, got %d", rec.Code)
	}
}

// helper to inject chi URL params when calling handlers directly
func withChiURLParam(r *http.Request, key, value string) *http.Request {
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, routeCtx))
}
