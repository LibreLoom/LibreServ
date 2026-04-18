package settings

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/logger"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) Get(key string) (string, error) {
	var value string
	err := r.db.QueryRow(`SELECT value FROM app_settings WHERE key = $1`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get setting %s: %w", key, err)
	}
	return value, nil
}

func (r *Repository) Set(key, value, typ string) error {
	_, err := r.db.Exec(`
		INSERT INTO app_settings (key, value, type, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (key) DO UPDATE SET
			value = EXCLUDED.value,
			type = EXCLUDED.type,
			updated_at = EXCLUDED.updated_at
	`, key, value, typ, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("set setting %s: %w", key, err)
	}
	return nil
}

func (r *Repository) SetTx(tx *sql.Tx, key, value, typ string) error {
	_, err := tx.Exec(`
		INSERT INTO app_settings (key, value, type, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (key) DO UPDATE SET
			value = EXCLUDED.value,
			type = EXCLUDED.type,
			updated_at = EXCLUDED.updated_at
	`, key, value, typ, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("set setting %s: %w", key, err)
	}
	return nil
}

func (r *Repository) GetAll() (map[string]string, error) {
	rows, err := r.db.Query(`SELECT key, value FROM app_settings`)
	if err != nil {
		return nil, fmt.Errorf("get all settings: %w", err)
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, fmt.Errorf("scan setting: %w", err)
		}
		result[key] = value
	}
	return result, rows.Err()
}

func (r *Repository) Delete(key string) error {
	_, err := r.db.Exec(`DELETE FROM app_settings WHERE key = $1`, key)
	if err != nil {
		return fmt.Errorf("delete setting %s: %w", key, err)
	}
	return nil
}

type Setting struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	Type      string    `json:"type"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (r *Repository) List() ([]Setting, error) {
	rows, err := r.db.Query(`SELECT key, value, type, updated_at FROM app_settings ORDER BY key`)
	if err != nil {
		return nil, fmt.Errorf("list settings: %w", err)
	}
	defer rows.Close()

	var settings []Setting
	for rows.Next() {
		var s Setting
		if err := rows.Scan(&s.Key, &s.Value, &s.Type, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan setting: %w", err)
		}
		settings = append(settings, s)
	}
	return settings, rows.Err()
}

func (r *Repository) SeedFromConfig() error {
	cfg := config.Get()
	if cfg == nil {
		return fmt.Errorf("config not loaded")
	}

	settings := map[string]string{
		"logging.level":          cfg.Logging.Level,
		"logging.path":           cfg.Logging.Path,
		"smtp.host":              cfg.SMTP.Host,
		"smtp.port":              strconv.Itoa(cfg.SMTP.Port),
		"smtp.username":          cfg.SMTP.Username,
		"smtp.password":          cfg.SMTP.Password,
		"smtp.from":              cfg.SMTP.From,
		"smtp.use_tls":           strconv.FormatBool(cfg.SMTP.UseTLS),
		"smtp.skip_verify":       strconv.FormatBool(cfg.SMTP.SkipVerify),
		"notify.enabled":         strconv.FormatBool(cfg.Notify.Enabled),
		"notify.welcome_subject": cfg.Notify.WelcomeSubject,
		"notify.welcome_body":    cfg.Notify.WelcomeBody,
		"notify.support_subject": cfg.Notify.SupportSubject,
		"notify.support_body":    cfg.Notify.SupportBody,
		"server.mode":            cfg.Server.Mode,
		"cors.allowed_origins":   stringSliceToCSV(cfg.CORS.AllowedOrigins),
	}

	for key, value := range settings {
		existing, _ := r.Get(key)
		if existing == "" && value != "" {
			if err := r.Set(key, value, typeFor(key)); err != nil {
				return err
			}
		}
	}

	notifyRecipients := cfg.Notify.SupportRecipients
	if len(notifyRecipients) > 0 {
		recipientsCSV := stringSliceToCSV(notifyRecipients)
		existing, _ := r.Get("notify.support_recipients")
		if existing == "" {
			if err := r.Set("notify.support_recipients", recipientsCSV, "json"); err != nil {
				return err
			}
		}
	}

	return nil
}

func (r *Repository) LoadIntoConfig() error {
	rows, err := r.db.Query(`SELECT key, value, type FROM app_settings`)
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}
	defer rows.Close()

	cfg := config.Get()
	if cfg == nil {
		return fmt.Errorf("config not loaded")
	}

	changes := map[string]string{}
	for rows.Next() {
		var key, value, typ string
		if err := rows.Scan(&key, &value, &typ); err != nil {
			return fmt.Errorf("scan setting: %w", err)
		}
		changes[key] = value
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if v, ok := changes["logging.level"]; ok && v != "" {
		cfg.Logging.Level = v
	}
	if v, ok := changes["logging.path"]; ok {
		cfg.Logging.Path = v
	}
	if v, ok := changes["smtp.host"]; ok {
		cfg.SMTP.Host = v
	}
	if v, ok := changes["smtp.port"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.SMTP.Port = n
		}
	}
	if v, ok := changes["smtp.username"]; ok {
		cfg.SMTP.Username = v
	}
	if v, ok := changes["smtp.password"]; ok {
		cfg.SMTP.Password = v
	}
	if v, ok := changes["smtp.from"]; ok {
		cfg.SMTP.From = v
	}
	if v, ok := changes["smtp.use_tls"]; ok {
		cfg.SMTP.UseTLS, _ = strconv.ParseBool(v)
	}
	if v, ok := changes["smtp.skip_verify"]; ok {
		cfg.SMTP.SkipVerify, _ = strconv.ParseBool(v)
	}
	if v, ok := changes["notify.enabled"]; ok {
		cfg.Notify.Enabled, _ = strconv.ParseBool(v)
	}
	if v, ok := changes["notify.support_recipients"]; ok {
		cfg.Notify.SupportRecipients = csvToStringSlice(v)
	}
	if v, ok := changes["notify.support_subject"]; ok {
		cfg.Notify.SupportSubject = v
	}
	if v, ok := changes["notify.support_body"]; ok {
		cfg.Notify.SupportBody = v
	}
	if v, ok := changes["notify.welcome_subject"]; ok {
		cfg.Notify.WelcomeSubject = v
	}
	if v, ok := changes["notify.welcome_body"]; ok {
		cfg.Notify.WelcomeBody = v
	}
	if v, ok := changes["server.mode"]; ok && v != "" {
		cfg.Server.Mode = v
	}
	if v, ok := changes["cors.allowed_origins"]; ok {
		cfg.CORS.AllowedOrigins = csvToStringSlice(v)
	}

	if v, ok := changes["network.caddy.default_domain"]; ok {
		cfg.Network.Caddy.DefaultDomain = v
	}
	if v, ok := changes["network.caddy.email"]; ok {
		cfg.Network.Caddy.Email = v
	}
	if v, ok := changes["network.caddy.auto_https"]; ok {
		cfg.Network.Caddy.AutoHTTPS, _ = strconv.ParseBool(v)
	}

	if _, ok := changes["logging.level"]; ok {
		logger.Init(cfg.Logging)
	}

	return nil
}

func (r *Repository) IsEmpty() (bool, error) {
	var count int
	err := r.db.QueryRow(`SELECT COUNT(*) FROM app_settings`).Scan(&count)
	if err != nil {
		return true, err
	}
	return count == 0, nil
}

type Service struct {
	repo *Repository
	mu   sync.RWMutex
}

func NewService(db *sql.DB) *Service {
	return &Service{repo: NewRepository(db)}
}

func (s *Service) Repository() *Repository {
	return s.repo
}

func (s *Service) GetSettings(ctx context.Context) (map[string]interface{}, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cfg := config.Get()
	if cfg == nil {
		return nil, fmt.Errorf("config not loaded")
	}

	settings := map[string]interface{}{
		"logging": map[string]interface{}{
			"level": cfg.Logging.Level,
			"path":  cfg.Logging.Path,
		},
		"smtp": map[string]interface{}{
			"host":        cfg.SMTP.Host,
			"port":        cfg.SMTP.Port,
			"username":    cfg.SMTP.Username,
			"from":        cfg.SMTP.From,
			"use_tls":     cfg.SMTP.UseTLS,
			"skip_verify": cfg.SMTP.SkipVerify,
			"configured":  cfg.SMTP.Password != "",
		},
		"notify": map[string]interface{}{
			"enabled":            cfg.Notify.Enabled,
			"support_recipients": cfg.Notify.SupportRecipients,
			"support_subject":    cfg.Notify.SupportSubject,
			"support_body":       cfg.Notify.SupportBody,
			"welcome_subject":    cfg.Notify.WelcomeSubject,
			"welcome_body":       cfg.Notify.WelcomeBody,
		},
		"server": map[string]interface{}{
			"host": cfg.Server.Host,
			"port": cfg.Server.Port,
			"mode": cfg.Server.Mode,
		},
	}

	if cfg.Network.Caddy.Mode != "" || cfg.Network.Caddy.AdminAPI != "" {
		proxyInfo := map[string]interface{}{
			"type": "caddy",
		}
		if cfg.Network.Caddy.Mode != "" {
			proxyInfo["mode"] = cfg.Network.Caddy.Mode
		}
		if cfg.Network.Caddy.AdminAPI != "" {
			proxyInfo["admin_api"] = cfg.Network.Caddy.AdminAPI
		}
		if cfg.Network.Caddy.ConfigPath != "" {
			proxyInfo["config_path"] = cfg.Network.Caddy.ConfigPath
		}
		if cfg.Network.Caddy.DefaultDomain != "" {
			proxyInfo["default_domain"] = cfg.Network.Caddy.DefaultDomain
		}
		if cfg.Network.Caddy.Email != "" {
			proxyInfo["ssl_email"] = cfg.Network.Caddy.Email
		}
		proxyInfo["auto_https"] = cfg.Network.Caddy.AutoHTTPS
		settings["proxy"] = proxyInfo
	}

	return settings, nil
}

func (s *Service) UpdateSettings(ctx context.Context, updates map[string]interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := config.Get()
	if cfg == nil {
		return fmt.Errorf("config not loaded")
	}

	type mutation struct {
		apply  func()
		commit func(tx *sql.Tx) error
	}
	var mutations []mutation

	if loggingRaw, ok := updates["logging"]; ok {
		logging, _ := loggingRaw.(map[string]interface{})
		if logging == nil {
			return fmt.Errorf("invalid logging format")
		}
		if level, ok := logging["level"].(string); ok && level != "" {
			validLevels := map[string]bool{
				"debug": true, "info": true, "warn": true, "error": true,
			}
			if !validLevels[level] {
				return fmt.Errorf("invalid logging level: must be one of debug, info, warn, error")
			}
			mutations = append(mutations, mutation{
				apply:  func() { cfg.Logging.Level = level },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "logging.level", level, "string") },
			})
		}
		if path, ok := logging["path"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.Logging.Path = path },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "logging.path", path, "string") },
			})
		}
	}

	if smtpRaw, ok := updates["smtp"]; ok {
		smtp, _ := smtpRaw.(map[string]interface{})
		if smtp == nil {
			return fmt.Errorf("invalid smtp format")
		}
		if host, ok := smtp["host"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.SMTP.Host = host },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "smtp.host", host, "string") },
			})
		}
		if port, ok := toInt(smtp["port"]); ok {
			if port < 1 || port > 65535 {
				return fmt.Errorf("invalid smtp port: must be between 1 and 65535")
			}
			p := port
			mutations = append(mutations, mutation{
				apply:  func() { cfg.SMTP.Port = p },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "smtp.port", strconv.Itoa(p), "int") },
			})
		}
		if username, ok := smtp["username"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.SMTP.Username = username },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "smtp.username", username, "string") },
			})
		}
		if password, ok := smtp["password"].(string); ok && password != "" {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.SMTP.Password = password },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "smtp.password", password, "string") },
			})
		}
		if from, ok := smtp["from"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.SMTP.From = from },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "smtp.from", from, "string") },
			})
		}
		if useTLS, ok := toBool(smtp["use_tls"]); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.SMTP.UseTLS = useTLS },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "smtp.use_tls", strconv.FormatBool(useTLS), "bool") },
			})
		}
		if skipVerify, ok := toBool(smtp["skip_verify"]); ok {
			mutations = append(mutations, mutation{
				apply: func() { cfg.SMTP.SkipVerify = skipVerify },
				commit: func(tx *sql.Tx) error {
					return s.repo.SetTx(tx, "smtp.skip_verify", strconv.FormatBool(skipVerify), "bool")
				},
			})
		}
	}

	if notifyRaw, ok := updates["notify"]; ok {
		notify, _ := notifyRaw.(map[string]interface{})
		if notify == nil {
			return fmt.Errorf("invalid notify format")
		}
		if enabled, ok := toBool(notify["enabled"]); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.Notify.Enabled = enabled },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "notify.enabled", strconv.FormatBool(enabled), "bool") },
			})
		}
		if recipients, ok := toStringSlice(notify["support_recipients"]); ok {
			mutations = append(mutations, mutation{
				apply: func() { cfg.Notify.SupportRecipients = recipients },
				commit: func(tx *sql.Tx) error {
					return s.repo.SetTx(tx, "notify.support_recipients", stringSliceToCSV(recipients), "json")
				},
			})
		}
		if subject, ok := notify["support_subject"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.Notify.SupportSubject = subject },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "notify.support_subject", subject, "string") },
			})
		}
		if body, ok := notify["support_body"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.Notify.SupportBody = body },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "notify.support_body", body, "string") },
			})
		}
		if subject, ok := notify["welcome_subject"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.Notify.WelcomeSubject = subject },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "notify.welcome_subject", subject, "string") },
			})
		}
		if body, ok := notify["welcome_body"].(string); ok {
			mutations = append(mutations, mutation{
				apply:  func() { cfg.Notify.WelcomeBody = body },
				commit: func(tx *sql.Tx) error { return s.repo.SetTx(tx, "notify.welcome_body", body, "string") },
			})
		}
	}

	if proxyRaw, ok := updates["proxy"]; ok {
		proxy, _ := proxyRaw.(map[string]interface{})
		if proxy == nil {
			return fmt.Errorf("invalid proxy format")
		}
		if defaultDomain, ok := proxy["default_domain"].(string); ok {
			mutations = append(mutations, mutation{
				apply: func() { cfg.Network.Caddy.DefaultDomain = defaultDomain },
				commit: func(tx *sql.Tx) error {
					return s.repo.SetTx(tx, "network.caddy.default_domain", defaultDomain, "string")
				},
			})
		}
		if sslEmail, ok := proxy["ssl_email"].(string); ok {
			mutations = append(mutations, mutation{
				apply: func() { cfg.Network.Caddy.Email = sslEmail },
				commit: func(tx *sql.Tx) error {
					return s.repo.SetTx(tx, "network.caddy.email", sslEmail, "string")
				},
			})
		}
		if autoHTTPS, ok := toBool(proxy["auto_https"]); ok {
			mutations = append(mutations, mutation{
				apply: func() { cfg.Network.Caddy.AutoHTTPS = autoHTTPS },
				commit: func(tx *sql.Tx) error {
					return s.repo.SetTx(tx, "network.caddy.auto_https", strconv.FormatBool(autoHTTPS), "bool")
				},
			})
		}
	}

	if len(mutations) == 0 {
		return nil
	}

	tx, err := s.repo.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}

	for _, m := range mutations {
		if err := m.commit(tx); err != nil {
			tx.Rollback()
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}

	for _, m := range mutations {
		m.apply()
	}

	// Reload settings from database to ensure GetSettings returns current values
	if err := s.repo.LoadIntoConfig(); err != nil {
		// Log error but don't fail - config was already updated in memory
		return fmt.Errorf("failed to reload settings from database: %w", err)
	}

	if _, ok := updates["logging"]; ok {
		logger.Init(cfg.Logging)
	}

	return nil
}

func typeFor(key string) string {
	switch key {
	case "smtp.port":
		return "int"
	case "smtp.use_tls", "smtp.skip_verify", "notify.enabled":
		return "bool"
	case "notify.support_recipients", "cors.allowed_origins":
		return "json"
	default:
		return "string"
	}
}

func stringSliceToCSV(slice []string) string {
	result := ""
	for i, s := range slice {
		if i > 0 {
			result += ","
		}
		result += s
	}
	return result
}

func csvToStringSlice(csv string) []string {
	if csv == "" {
		return nil
	}
	var result []string
	for _, s := range splitCSV(csv) {
		if s != "" {
			result = append(result, s)
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func splitCSV(s string) []string {
	var parts []string
	current := ""
	inQuote := false
	for _, c := range s {
		if c == '"' {
			inQuote = !inQuote
			continue
		}
		if c == ',' && !inQuote {
			parts = append(parts, current)
			current = ""
			continue
		}
		current += string(c)
	}
	parts = append(parts, current)
	return parts
}

func toInt(v interface{}) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case string:
		i, err := strconv.Atoi(n)
		return i, err == nil
	default:
		return 0, false
	}
}

func toBool(v interface{}) (bool, bool) {
	switch b := v.(type) {
	case bool:
		return b, true
	case string:
		parsed, err := strconv.ParseBool(b)
		return parsed, err == nil
	default:
		return false, false
	}
}

func toStringSlice(v interface{}) ([]string, bool) {
	switch s := v.(type) {
	case []string:
		return s, true
	case []interface{}:
		var result []string
		for _, item := range s {
			if str, ok := item.(string); ok {
				result = append(result, str)
			}
		}
		return result, true
	case string:
		return csvToStringSlice(s), true
	default:
		return nil, false
	}
}
