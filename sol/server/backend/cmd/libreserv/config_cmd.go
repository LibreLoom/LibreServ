package main

import (
	"database/sql"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"

	_ "modernc.org/sqlite"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

const configUsage = `LibreServ configuration management.

Usage:
  libreserv config defaults [--config PATH]   Print all default config values
  libreserv config get <key> [--config PATH]  Print resolved value for a key
  libreserv config set <key> <value>          Set a DB-backed setting

DB-backed keys (change via 'config set' or Settings UI):
  logging.level, logging.path, smtp.host, smtp.port, smtp.username,
  smtp.password, smtp.from, smtp.use_tls, smtp.skip_verify,
  notify.enabled, notify.support_recipients, notify.support_subject,
  notify.support_body, notify.welcome_subject, notify.welcome_body,
  server.mode, cors.allowed_origins,
  network.caddy.mode, network.caddy.default_domain,
  network.caddy.email, network.caddy.auto_https,
  updates.base_url, updates.owner, updates.repo

All other keys are YAML-only — edit the config file directly.
`

// dbBackedKeys lists all settings that are stored in the database (app_settings table).
// These keys can be changed via 'libreserv config set' or the Settings UI.
// When adding a new DB-backed key, also update SeedFromConfig() in internal/settings/repository.go.
var dbBackedKeys = map[string]string{
	"logging.level":                "string",
	"logging.path":                 "string",
	"smtp.host":                    "string",
	"smtp.port":                    "int",
	"smtp.username":                "string",
	"smtp.password":                "string",
	"smtp.from":                    "string",
	"smtp.use_tls":                 "bool",
	"smtp.skip_verify":             "bool",
	"notify.enabled":               "bool",
	"notify.support_recipients":    "csv",
	"notify.support_subject":       "string",
	"notify.support_body":          "string",
	"notify.welcome_subject":       "string",
	"notify.welcome_body":          "string",
	"server.mode":                  "string",
	"cors.allowed_origins":         "csv",
	"network.caddy.mode":           "string",
	"network.caddy.default_domain": "string",
	"network.caddy.email":          "string",
	"network.caddy.auto_https":     "bool",
	"updates.base_url":             "string",
	"updates.owner":                "string",
	"updates.repo":                 "string",
}

var validEnums = map[string][]string{
	"server.mode":        {"development", "production"},
	"network.caddy.mode": {"enabled", "disabled", "noop"},
	"logging.level":      {"debug", "info", "warn", "error"},
}

func handleConfigCommand(args []string, cfgPath string) {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, configUsage)
		os.Exit(2)
	}

	switch args[0] {
	case "defaults":
		cmdConfigDefaults(cfgPath)
	case "get":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: libreserv config get <key>")
			os.Exit(2)
		}
		cmdConfigGet(args[1], cfgPath)
	case "set":
		if len(args) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: libreserv config set <key> <value>")
			os.Exit(2)
		}
		cmdConfigSet(args[1], args[2], cfgPath)
	default:
		fmt.Fprintf(os.Stderr, "Unknown config subcommand: %s\n", args[0])
		fmt.Fprint(os.Stderr, configUsage)
		os.Exit(2)
	}
}

func cmdConfigDefaults(cfgPath string) {
	printViperDefaults()
}

func cmdConfigGet(key string, cfgPath string) {
	if err := config.LoadConfig(cfgPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to load config: %v\n", err)
		os.Exit(1)
	}
	cfg := config.Get()

	dbPath := cfg.Database.Path
	if dbPath == "" {
		dbPath = "/var/lib/libreserv/libreserv.db"
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: cannot open database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	repo := settings.NewRepository(db)

	if _, isDBBacked := dbBackedKeys[key]; isDBBacked {
		val, err := repo.Get(key)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: failed to read setting: %v\n", err)
			os.Exit(1)
		}
		if val != "" {
			fmt.Println(val)
			return
		}
	}

	fmt.Println(resolveConfigValue(key, cfg))
}

func cmdConfigSet(key, value, cfgPath string) {
	typ, isDBBacked := dbBackedKeys[key]
	if !isDBBacked {
		fmt.Fprintf(os.Stderr, "error: key %q is YAML-only — edit the config file directly (%s)\n", key, cfgPath)
		os.Exit(1)
	}

	if err := validateConfigValue(key, value, typ); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	if err := config.LoadConfig(cfgPath); err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to load config: %v\n", err)
		os.Exit(1)
	}
	cfg := config.Get()

	dbPath := cfg.Database.Path
	if dbPath == "" {
		dbPath = "/var/lib/libreserv/libreserv.db"
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: cannot open database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	repo := settings.NewRepository(db)
	if err := repo.Set(key, value, typ); err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to set %s: %v\n", key, err)
		os.Exit(1)
	}

	fmt.Printf("Set %s = %s\n", key, value)
	fmt.Println("Change takes effect on next restart.")
}

func validateConfigValue(key, value, typ string) error {
	if enums, ok := validEnums[key]; ok {
		for _, e := range enums {
			if value == e {
				return nil
			}
		}
		return fmt.Errorf("invalid value %q for %s: must be one of %s", value, key, strings.Join(enums, ", "))
	}

	switch typ {
	case "int":
		if _, err := strconv.Atoi(value); err != nil {
			return fmt.Errorf("invalid value %q for %s: must be an integer", value, key)
		}
	case "bool":
		if _, err := strconv.ParseBool(value); err != nil {
			return fmt.Errorf("invalid value %q for %s: must be true or false", value, key)
		}
	}
	return nil
}

func resolveConfigValue(key string, cfg *config.Config) string {
	parts := strings.SplitN(key, ".", 3)
	if len(parts) < 2 {
		return ""
	}

	switch parts[0] {
	case "server":
		switch parts[1] {
		case "host":
			return cfg.Server.Host
		case "port":
			return strconv.Itoa(cfg.Server.Port)
		case "mode":
			return cfg.Server.Mode
		}
	case "database":
		if parts[1] == "path" {
			return cfg.Database.Path
		}
	case "apps":
		switch parts[1] {
		case "data_path":
			return cfg.Apps.DataPath
		case "catalog_path":
			return cfg.Apps.CatalogPath
		}
	case "runtime":
		switch parts[1] {
		case "method":
			return cfg.Runtime.Method
		case "socket_path":
			return cfg.Runtime.SocketPath
		}
	case "logging":
		switch parts[1] {
		case "level":
			return cfg.Logging.Level
		case "path":
			return cfg.Logging.Path
		}
	case "smtp":
		switch parts[1] {
		case "host":
			return cfg.SMTP.Host
		case "port":
			return strconv.Itoa(cfg.SMTP.Port)
		case "username":
			return cfg.SMTP.Username
		case "from":
			return cfg.SMTP.From
		case "use_tls":
			return strconv.FormatBool(cfg.SMTP.UseTLS)
		case "skip_verify":
			return strconv.FormatBool(cfg.SMTP.SkipVerify)
		case "password":
			return "<redacted>"
		}
	case "notify":
		switch parts[1] {
		case "enabled":
			return strconv.FormatBool(cfg.Notify.Enabled)
		case "support_recipients":
			return strings.Join(cfg.Notify.SupportRecipients, ",")
		case "support_subject":
			return cfg.Notify.SupportSubject
		case "support_body":
			return cfg.Notify.SupportBody
		case "welcome_subject":
			return cfg.Notify.WelcomeSubject
		case "welcome_body":
			return cfg.Notify.WelcomeBody
		}
	case "cors":
		if parts[1] == "allowed_origins" {
			return strings.Join(cfg.CORS.AllowedOrigins, ",")
		}
	case "network":
		if parts[1] == "caddy" && len(parts) == 3 {
			switch parts[2] {
			case "mode":
				return cfg.Network.Caddy.Mode
			case "admin_api":
				return cfg.Network.Caddy.AdminAPI
			case "config_path":
				return cfg.Network.Caddy.ConfigPath
			case "certs_path":
				return cfg.Network.Caddy.CertsPath
			case "default_domain":
				return cfg.Network.Caddy.DefaultDomain
			case "email":
				return cfg.Network.Caddy.Email
			case "auto_https":
				return strconv.FormatBool(cfg.Network.Caddy.AutoHTTPS)
			}
		}
	case "auth":
		switch parts[1] {
		case "jwt_secret":
			return "<redacted>"
		case "csrf_secret":
			return "<redacted>"
		}
	case "updates":
		switch parts[1] {
		case "base_url":
			return cfg.Updates.BaseURL
		case "owner":
			return cfg.Updates.Owner
		case "repo":
			return cfg.Updates.Repo
		}
	}
	return ""
}

func printViperDefaults() {
	v := viper.New()
	config.SetDefaults(v)

	keys := v.AllKeys()
	sort.Strings(keys)

	type mapEntry struct {
		Key   string      `yaml:"key"`
		Value interface{} `yaml:"value"`
	}
	var entries []mapEntry
	for _, k := range keys {
		entries = append(entries, mapEntry{Key: k, Value: v.Get(k)})
	}

	data, err := yaml.Marshal(entries)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Print(string(data))
}
