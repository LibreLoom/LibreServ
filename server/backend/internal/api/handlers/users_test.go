package handlers

import (
	"bytes"
	"context"
	"encoding/json"
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
	svc := auth.NewService(db, "secret")
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

	// delete user
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/api/v1/users/"+id, nil).WithContext(ctx)
	req = withChiURLParam(req, "userID", id)
	h.DeleteUser(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status %d", rec.Code)
	}
}

// helper to inject chi URL params when calling handlers directly
func withChiURLParam(r *http.Request, key, value string) *http.Request {
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, routeCtx))
}
