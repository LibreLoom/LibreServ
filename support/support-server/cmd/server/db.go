package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type DB struct {
	db *sql.DB
}

func NewDB(path string) (*DB, error) {
	db, err := sql.Open("sqlite3", path+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &DB{db: db}, nil
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS devices (
			device_id TEXT PRIMARY KEY,
			plan_id TEXT NOT NULL DEFAULT 'free',
			status TEXT NOT NULL DEFAULT 'active',
			server_token TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS credit_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS plan_configs (
			plan_id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			price_monthly INTEGER NOT NULL DEFAULT 0,
			credit_cap_usd REAL NOT NULL DEFAULT 0,
			human_escalation INTEGER NOT NULL DEFAULT 0,
			self_healing INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_credit_events_device ON credit_events(device_id);
		CREATE INDEX IF NOT EXISTS idx_credit_events_created ON credit_events(created_at);
	`)
	return err
}

func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) GetDevice(deviceID string) (map[string]interface{}, error) {
	row := d.db.QueryRow(`SELECT device_id, plan_id, status, server_token, created_at, updated_at FROM devices WHERE device_id = ?`, deviceID)
	var id, planID, status, token string
	var created, updated time.Time
	if err := row.Scan(&id, &planID, &status, &token, &created, &updated); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return map[string]interface{}{
		"device_id":     id,
		"plan_id":       planID,
		"status":        status,
		"server_token":   token,
		"created_at":     created,
		"updated_at":     updated,
	}, nil
}

func (d *DB) UpsertDevice(deviceID, planID, serverToken string) error {
	_, err := d.db.Exec(`
		INSERT INTO devices (device_id, plan_id, server_token, updated_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(device_id) DO UPDATE SET plan_id = ?, server_token = ?, updated_at = CURRENT_TIMESTAMP
	`, deviceID, planID, serverToken, planID, serverToken)
	return err
}

func (d *DB) RecordCredit(deviceID, conversationID, model string, inputTokens, outputTokens int, costUSD float64) error {
	_, err := d.db.Exec(`
		INSERT INTO credit_events (device_id, conversation_id, model, input_tokens, output_tokens, cost_usd)
		VALUES (?, ?, ?, ?, ?, ?)
	`, deviceID, conversationID, model, inputTokens, outputTokens, costUSD)
	return err
}

func (d *DB) CreditUsage(deviceID string, since time.Time) (float64, error) {
	var total float64
	err := d.db.QueryRow(`SELECT COALESCE(SUM(cost_usd), 0) FROM credit_events WHERE device_id = ? AND created_at >= ?`, deviceID, since).Scan(&total)
	return total, err
}

func (d *DB) SetPlan(planID, name string, priceMonthly int, creditCapUSD float64, humanEscalation, selfHealing bool) error {
	_, err := d.db.Exec(`
		INSERT INTO plan_configs (plan_id, name, price_monthly, credit_cap_usd, human_escalation, self_healing)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(plan_id) DO UPDATE SET name = ?, price_monthly = ?, credit_cap_usd = ?, human_escalation = ?, self_healing = ?
	`, planID, name, priceMonthly, creditCapUSD, humanEscalation, selfHealing,
		name, priceMonthly, creditCapUSD, humanEscalation, selfHealing)
	return err
}

func (d *DB) GetPlan(planID string) (map[string]interface{}, error) {
	row := d.db.QueryRow(`SELECT plan_id, name, price_monthly, credit_cap_usd, human_escalation, self_healing FROM plan_configs WHERE plan_id = ?`, planID)
	var id, name string
	var priceMonthly int
	var creditCapUSD float64
	var humanEsc, selfHeal bool
	if err := row.Scan(&id, &name, &priceMonthly, &creditCapUSD, &humanEsc, &selfHeal); err != nil {
		if err == sql.ErrNoRows {
			return map[string]interface{}{
				"plan_id":          "free",
				"name":             "Free",
				"price_monthly":    0,
				"credit_cap_usd":   0.0,
				"human_escalation": false,
				"self_healing":     false,
			}, nil
		}
		return nil, err
	}
	return map[string]interface{}{
		"plan_id":          id,
		"name":             name,
		"price_monthly":    priceMonthly,
		"credit_cap_usd":   creditCapUSD,
		"human_escalation": humanEsc,
		"self_healing":     selfHeal,
	}, nil
}

func (d *DB) ListPlans() ([]map[string]interface{}, error) {
	rows, err := d.db.Query(`SELECT plan_id, name, price_monthly, credit_cap_usd, human_escalation, self_healing FROM plan_configs ORDER BY price_monthly`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var plans []map[string]interface{}
	for rows.Next() {
		var id, name string
		var priceMonthly int
		var creditCapUSD float64
		var humanEsc, selfHeal bool
		if err := rows.Scan(&id, &name, &priceMonthly, &creditCapUSD, &humanEsc, &selfHeal); err != nil {
			continue
		}
		plans = append(plans, map[string]interface{}{
			"plan_id":          id,
			"name":             name,
			"price_monthly":    priceMonthly,
			"credit_cap_usd":   creditCapUSD,
			"human_escalation": humanEsc,
			"self_healing":     selfHeal,
		})
	}
	return plans, nil
}

func seedDefaultPlans(d *DB) {
	plans := []struct {
		id, name string
		price     int
		credit    float64
		human     bool
		heal      bool
	}{
		{"free", "Free", 0, 0.0, false, false},
		{"basic", "Basic", 1500, 10.0, false, true},
		{"premium", "Premium", 2500, 20.0, true, true},
	}
	for _, p := range plans {
		if err := d.SetPlan(p.id, p.name, p.price, p.credit, p.human, p.heal); err != nil {
			log.Printf("seed plan %s: %v", p.id, err)
		}
	}
}

func initDB() *DB {
	dbPath := os.Getenv("SUPPORT_DB_PATH")
	if dbPath == "" {
		dbPath = "support-server.db"
	}
	db, err := NewDB(dbPath)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	seedDefaultPlans(db)
	return db
}

func handleGetSubscription(d *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		deviceID := r.URL.Query().Get("device_id")
		if deviceID == "" {
			http.Error(w, "device_id required", http.StatusBadRequest)
			return
		}
		device, err := d.GetDevice(deviceID)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		planID := "free"
		if device != nil {
			if pid, ok := device["plan_id"].(string); ok {
				planID = pid
			}
		}
		plan, err := d.GetPlan(planID)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		now := time.Now()
		startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		usedUSD, _ := d.CreditUsage(deviceID, startOfMonth)
		capUSD, _ := plan["credit_cap_usd"].(float64)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"device":        device,
			"plan":          plan,
			"used_usd":      usedUSD,
			"remaining_usd": capUSD - usedUSD,
		})
	}
}

func handleLinkSubscription(d *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			DeviceID     string `json:"device_id"`
			PlanID       string `json:"plan_id"`
			ServerToken  string `json:"server_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if req.DeviceID == "" || req.PlanID == "" {
			http.Error(w, "device_id and plan_id required", http.StatusBadRequest)
			return
		}
		if err := d.UpsertDevice(req.DeviceID, req.PlanID, req.ServerToken); err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "linked"})
	}
}

func handleReportCredits(d *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			DeviceID       string  `json:"device_id"`
			ConversationID string  `json:"conversation_id"`
			Model          string  `json:"model"`
			InputTokens    int     `json:"input_tokens"`
			OutputTokens   int     `json:"output_tokens"`
			CostUSD        float64 `json:"cost_usd"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if req.DeviceID == "" {
			http.Error(w, "device_id required", http.StatusBadRequest)
			return
		}
		if err := d.RecordCredit(req.DeviceID, req.ConversationID, req.Model, req.InputTokens, req.OutputTokens, req.CostUSD); err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "recorded"})
	}
}

func handleListPlans(d *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		plans, err := d.ListPlans()
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"plans": plans,
			"count": len(plans),
		})
	}
}
