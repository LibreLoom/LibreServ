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
		CREATE TABLE IF NOT EXISTS support_cases (
			id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			summary TEXT NOT NULL,
			session_code TEXT NOT NULL DEFAULT '',
			contact TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open',
			scopes TEXT NOT NULL DEFAULT '[]',
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		);
		CREATE TABLE IF NOT EXISTS case_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
			author TEXT NOT NULL,
			text TEXT NOT NULL,
			timestamp TIMESTAMP NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_case_messages_case ON case_messages(case_id);
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
		"device_id":    id,
		"plan_id":      planID,
		"status":       status,
		"server_token": token,
		"created_at":   created,
		"updated_at":   updated,
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
		price    int
		credit   float64
		human    bool
		heal     bool
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
			DeviceID    string `json:"device_id"`
			PlanID      string `json:"plan_id"`
			ServerToken string `json:"server_token"`
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

func (d *DB) CreateCase(id, deviceID, summary, sessionCode, contact string, scopes []string) (*SupportCase, error) {
	scopesJSON, _ := json.Marshal(scopes)
	now := time.Now()
	_, err := d.db.Exec(`
		INSERT INTO support_cases (id, device_id, summary, session_code, contact, status, scopes, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, deviceID, summary, sessionCode, contact, string(StatusOpen), string(scopesJSON), now, now)
	if err != nil {
		return nil, err
	}
	return &SupportCase{
		ID:          id,
		DeviceID:    deviceID,
		Summary:     summary,
		SessionCode: sessionCode,
		Contact:     contact,
		Status:      StatusOpen,
		Scopes:      scopes,
		Messages:    []CaseMsg{},
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

func (d *DB) GetCase(id string) (*SupportCase, error) {
	row := d.db.QueryRow(`
		SELECT id, device_id, summary, session_code, contact, status, scopes, created_at, updated_at
		FROM support_cases WHERE id = ?
	`, id)
	var c SupportCase
	var scopesJSON string
	var sessionCode, contact sql.NullString
	if err := row.Scan(&c.ID, &c.DeviceID, &c.Summary, &sessionCode, &contact, &c.Status, &scopesJSON, &c.CreatedAt, &c.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	c.SessionCode = sessionCode.String
	c.Contact = contact.String
	_ = json.Unmarshal([]byte(scopesJSON), &c.Scopes)
	messages, err := d.getMessages(id)
	if err != nil {
		return nil, err
	}
	c.Messages = messages
	return &c, nil
}

func (d *DB) getMessages(caseID string) ([]CaseMsg, error) {
	rows, err := d.db.Query(`
		SELECT author, text, timestamp FROM case_messages WHERE case_id = ? ORDER BY timestamp
	`, caseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []CaseMsg{}
	for rows.Next() {
		var m CaseMsg
		if err := rows.Scan(&m.Author, &m.Text, &m.Timestamp); err != nil {
			continue
		}
		messages = append(messages, m)
	}
	return messages, nil
}

func (d *DB) ListCases() ([]*SupportCase, error) {
	rows, err := d.db.Query(`
		SELECT id, device_id, summary, session_code, contact, status, scopes, created_at, updated_at
		FROM support_cases ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cases := []*SupportCase{}
	for rows.Next() {
		var c SupportCase
		var scopesJSON string
		var sessionCode, contact sql.NullString
		if err := rows.Scan(&c.ID, &c.DeviceID, &c.Summary, &sessionCode, &contact, &c.Status, &scopesJSON, &c.CreatedAt, &c.UpdatedAt); err != nil {
			continue
		}
		c.SessionCode = sessionCode.String
		c.Contact = contact.String
		_ = json.Unmarshal([]byte(scopesJSON), &c.Scopes)
		messages, err := d.getMessages(c.ID)
		if err != nil {
			continue
		}
		c.Messages = messages
		cases = append(cases, &c)
	}
	return cases, nil
}

func (d *DB) CaseExists(id string) (bool, error) {
	var count int
	err := d.db.QueryRow(`SELECT 1 FROM support_cases WHERE id = ?`, id).Scan(&count)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (d *DB) AddMessage(caseID, author, text string, timestamp time.Time) error {
	_, err := d.db.Exec(`
		INSERT INTO case_messages (case_id, author, text, timestamp) VALUES (?, ?, ?, ?)
	`, caseID, author, text, timestamp)
	if err != nil {
		return err
	}
	_, err = d.db.Exec(`UPDATE support_cases SET updated_at = ? WHERE id = ?`, timestamp, caseID)
	return err
}

func (d *DB) UpdateCaseStatus(id string, status CaseStatus, updatedAt time.Time) error {
	res, err := d.db.Exec(`UPDATE support_cases SET status = ?, updated_at = ? WHERE id = ?`, string(status), updatedAt, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (d *DB) UpdateCaseScopes(id string, scopes []string, updatedAt time.Time) error {
	scopesJSON, _ := json.Marshal(scopes)
	res, err := d.db.Exec(`UPDATE support_cases SET scopes = ?, updated_at = ? WHERE id = ?`, string(scopesJSON), updatedAt, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func handleCreateCase(d *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		id := generateID()
		c, err := d.CreateCase(id, req.DeviceID, req.Summary, req.SessionCode, req.Contact, req.Scopes)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, c)
	}
}

func handleListCases(d *DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cases, err := d.ListCases()
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"cases": cases,
			"count": len(cases),
		})
	}
}

func handleGetCase(d *DB, id string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := d.GetCase(id)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		if c == nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, c)
	}
}

func handleAddMessage(d *DB, id string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Author string `json:"author"`
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
		exists, err := d.CaseExists(id)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		if !exists {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		now := time.Now()
		if err := d.AddMessage(id, req.Author, req.Text, now); err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		c, err := d.GetCase(id)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, c)
	}
}

func handleUpdateStatus(d *DB, id string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		if err := d.UpdateCaseStatus(id, req.Status, now); err != nil {
			if err == sql.ErrNoRows {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		c, err := d.GetCase(id)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, c)
	}
}

func handleUpdateScopes(d *DB, id string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Scopes []string `json:"scopes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		now := time.Now()
		if err := d.UpdateCaseScopes(id, req.Scopes, now); err != nil {
			if err == sql.ErrNoRows {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		c, err := d.GetCase(id)
		if err != nil {
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, c)
	}
}
