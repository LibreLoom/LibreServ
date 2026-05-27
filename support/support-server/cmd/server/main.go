package main

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
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

func main() {
	adminToken := os.Getenv("SUPPORT_ADMIN_TOKEN")
	deviceToken := os.Getenv("SUPPORT_DEVICE_TOKEN")
	addr := os.Getenv("SUPPORT_SERVER_ADDR")
	if addr == "" {
		addr = defaultListen
	}

	if adminToken == "" && deviceToken == "" {
		if os.Getenv("SUPPORT_INSECURE_DEV") != "true" {
			log.Fatal("SUPPORT_ADMIN_TOKEN and SUPPORT_DEVICE_TOKEN must be set. Set SUPPORT_INSECURE_DEV=true to allow running without authentication (development only).")
		}
		log.Printf("WARNING: running without authentication — development mode only")
	}

	db := initDB()
	defer db.Close()

	mux := http.NewServeMux()

	mux.Handle("/healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))

	inferenceBaseURL := os.Getenv("INFERENCE_BASE_URL")
	inferenceAPIKey := os.Getenv("INFERENCE_API_KEY")
	var proxy *InferenceProxy
	if inferenceBaseURL != "" && inferenceAPIKey != "" {
		proxy = NewInferenceProxy(inferenceBaseURL, inferenceAPIKey, db)
		log.Printf("inference proxy enabled: %s", inferenceBaseURL)
	} else {
		log.Printf("WARNING: inference proxy disabled — INFERENCE_BASE_URL and INFERENCE_API_KEY not set")
	}

	// Rate limiters
	generalRL := newRateLimiter(0.5, 30)   // 30 req/min per IP, burst 30
	inferenceRL := newRateLimiter(1.0, 60) // 60 req/min per device, burst 60
	generalMiddleware := rateLimitMiddleware(generalRL)
	inferenceMiddleware := rateLimitDeviceMiddleware(inferenceRL)

	casesHandler := authHandler(adminToken, deviceToken, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleListCases(db)(w, r)
		case http.MethodPost:
			handleCreateCase(db)(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.Handle("/api/cases", generalMiddleware(casesHandler))

	casesSubHandler := authHandler(adminToken, deviceToken, func(w http.ResponseWriter, r *http.Request) {
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
			handleGetCase(db, id)(w, r)
			return
		}
		action := parts[1]
		switch action {
		case "messages":
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleAddMessage(db, id)(w, r)
		case "status":
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleUpdateStatus(db, id)(w, r)
		case "scopes":
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleUpdateScopes(db, id)(w, r)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	})
	mux.Handle("/api/cases/", generalMiddleware(casesSubHandler))

	subHandler := authHandler(adminToken, deviceToken, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleGetSubscription(db).ServeHTTP(w, r)
		case http.MethodPost:
			handleLinkSubscription(db).ServeHTTP(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.Handle("/api/subscriptions", generalMiddleware(subHandler))

	creditsHandler := authHandler(adminToken, deviceToken, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleReportCredits(db).ServeHTTP(w, r)
	})
	mux.Handle("/api/subscriptions/credits", generalMiddleware(creditsHandler))

	plansHandler := authHandler(adminToken, deviceToken, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleListPlans(db).ServeHTTP(w, r)
	})
	mux.Handle("/api/plans", generalMiddleware(plansHandler))

	if proxy != nil {
		completionsHandler := authHandler(adminToken, deviceToken, proxy.HandleChatCompletions)
		modelsHandler := authHandler(adminToken, deviceToken, proxy.HandleModels)
		mux.Handle("/api/v1/inference/chat/completions", inferenceMiddleware(completionsHandler))
		mux.Handle("/api/v1/inference/models", inferenceMiddleware(modelsHandler))
	}

	server := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 5 * time.Minute,
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
			log.Printf("WARNING: request served without authentication (no tokens configured)")
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
