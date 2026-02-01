package main

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type CaseStatus string

const (
	StatusOpen     CaseStatus = "open"
	StatusPending  CaseStatus = "pending_user"
	StatusResolved CaseStatus = "resolved"
	StatusClosed   CaseStatus = "closed"
	defaultListen             = ":8085"
)

type SupportCase struct {
	ID          string     `json:"id"`
	DeviceID    string     `json:"device_id"`
	Summary     string     `json:"summary"`
	SessionCode string     `json:"session_code,omitempty"`
	Contact     string     `json:"contact,omitempty"`
	Status      CaseStatus `json:"status"`
	Scopes      []string   `json:"scopes"`
	Messages    []CaseMsg  `json:"messages"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type CaseMsg struct {
	Author    string    `json:"author"` // "user" or "agent"
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
}

type store struct {
	mu    sync.RWMutex
	cases map[string]*SupportCase
}

func main() {
	adminToken := os.Getenv("SUPPORT_ADMIN_TOKEN")
	deviceToken := os.Getenv("SUPPORT_DEVICE_TOKEN")
	addr := os.Getenv("SUPPORT_SERVER_ADDR")
	if addr == "" {
		addr = defaultListen
	}

	s := &store{cases: make(map[string]*SupportCase)}
	mux := http.NewServeMux()

	mux.Handle("/healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))

	mux.Handle("/api/cases", authHandler(adminToken, deviceToken, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			s.listCases(w, r)
		case http.MethodPost:
			s.createCase(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}))

	mux.Handle("/api/cases/", authHandler(adminToken, deviceToken, func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/cases/")
		if path == "" {
			http.Error(w, "case id required", http.StatusBadRequest)
			return
		}
		parts := strings.Split(path, "/")
		id := parts[0]
		if len(parts) == 1 {
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.getCase(w, r, id)
			return
		}
		action := parts[1]
		switch action {
		case "messages":
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.addMessage(w, r, id)
		case "status":
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.updateStatus(w, r, id)
		case "scopes":
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			s.updateScopes(w, r, id)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))

	server := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("support-server listening on %s", addr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("support-server failed: %v", err)
	}
}

func authHandler(adminToken, deviceToken string, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if adminToken == "" && deviceToken == "" {
			next.ServeHTTP(w, r)
			return
		}
		token := r.Header.Get("Authorization")
		token = strings.TrimPrefix(token, "Bearer ")
		switch r.Header.Get("X-Client-Role") {
		case "admin":
			if token != adminToken {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		case "device":
			if token != deviceToken {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		default:
			http.Error(w, "role required", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *store) createCase(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceID    string   `json:"device_id"`
		Summary     string   `json:"summary"`
		SessionCode string   `json:"session_code"`
		Contact     string   `json:"contact"`
		Scopes      []string `json:"scopes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.DeviceID == "" || req.Summary == "" {
		http.Error(w, "device_id and summary required", http.StatusBadRequest)
		return
	}
	now := time.Now()
	id := generateID()
	c := &SupportCase{
		ID:          id,
		DeviceID:    req.DeviceID,
		Summary:     req.Summary,
		SessionCode: req.SessionCode,
		Contact:     req.Contact,
		Scopes:      req.Scopes,
		Status:      StatusOpen,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	s.mu.Lock()
	s.cases[id] = c
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, c)
}

func (s *store) listCases(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var list []*SupportCase
	for _, c := range s.cases {
		list = append(list, c)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"cases": list,
		"count": len(list),
	})
}

func (s *store) getCase(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.cases[id]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *store) addMessage(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Author string `json:"author"` // "user" or "agent"
		Text   string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Text == "" || req.Author == "" {
		http.Error(w, "author and text required", http.StatusBadRequest)
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cases[id]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	c.Messages = append(c.Messages, CaseMsg{
		Author:    req.Author,
		Text:      req.Text,
		Timestamp: now,
	})
	c.UpdatedAt = now
	writeJSON(w, http.StatusOK, c)
}

func (s *store) updateStatus(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Status CaseStatus `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Status == "" {
		http.Error(w, "status required", http.StatusBadRequest)
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cases[id]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	c.Status = req.Status
	c.UpdatedAt = now
	writeJSON(w, http.StatusOK, c)
}

func (s *store) updateScopes(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Scopes []string `json:"scopes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cases[id]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	c.Scopes = req.Scopes
	c.UpdatedAt = now
	writeJSON(w, http.StatusOK, c)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func generateID() string {
	return strings.ReplaceAll(time.Now().UTC().Format("20060102T150405.000000000"), ".", "") + "-" + randomString(6)
}

func randomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, n)
	_, _ = rand.Read(out)
	for i := range out {
		out[i] = letters[int(out[i])%len(letters)]
	}
	return string(out)
}
