package security

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"regexp"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

var (
	warningLogger = slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelWarn,
	}))
	infoLogger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
)

const (
	DevModeWarning = `
╔══════════════════════════════════════════════════════════════════════╗
║                    ⚠️  DEVELOPMENT MODE ACTIVE  ⚠️                   ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  This server is running in DEVELOPMENT mode.                         ║
║                                                                      ║
║  SECURITY IMPLICATIONS:                                              ║
║  • Authentication bypass is enabled (dev-token: "dev-token")         ║
║  • CORS is configured to allow all origins                           ║
║  • Debug logging is enabled                                          ║
║  • Additional endpoints may be exposed                               ║
║                                                                      ║
║  PRODUCTION USE ONLY IF:                                             ║
║  • You understand the security implications                          ║
║  • The server is not exposed to the public internet                  ║
║  • You have reviewed and accepted the risks                          ║
║                                                                      ║
║  TO ENABLE DEV MODE: Set LIBRESERV_INSECURE_DEV=true                ║
║  TO SECURE: Set server.mode to "production" in configuration.        ║
╚══════════════════════════════════════════════════════════════════════╝`
)

const (
	InsecureConfigWarning = `
╔══════════════════════════════════════════════════════════════════════╗
║                 ⚠️  INSECURE CONFIGURATION DETECTED  ⚠️              ║
╠══════════════════════════════════════════════════════════════════════╣`
)

type SecurityIssue struct {
	Severity       string
	Category       string
	Message        string
	Recommendation string
}

type ValidationResult struct {
	Issues    []SecurityIssue
	Passed    bool
	IsDevMode bool
}

func ValidateConfig() *ValidationResult {
	cfg := config.Get()
	result := &ValidationResult{
		Issues:    make([]SecurityIssue, 0),
		Passed:    true,
		IsDevMode: cfg.Server.Mode == "development",
	}

	if result.IsDevMode {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "HIGH",
			Category:       "Mode",
			Message:        "Server is running in development mode",
			Recommendation: "Set server.mode to 'production' for production use",
		})
		result.Passed = false
	}

	validateDevModeSettings(cfg, result)
	validateCORS(cfg, result)
	validateSecrets(cfg, result)
	validateNetworkBindings(cfg, result)
	validateLogging(cfg, result)
	validateDocker(cfg, result)
	validateCSRF(cfg, result)

	return result
}

func validateDevModeSettings(cfg *config.Config, result *ValidationResult) {
	if !result.IsDevMode {
		return
	}

	devTokenEnabled := os.Getenv("LIBRESERV_DEV_TOKEN_ENABLED")
	if devTokenEnabled == "" {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "CRITICAL",
			Category:       "Dev Mode",
			Message:        "Dev token authentication bypass is implicitly enabled",
			Recommendation: "Set LIBRESERV_DEV_TOKEN_ENABLED=false to explicitly disable, or run in production mode",
		})
		result.Passed = false
	} else if devTokenEnabled == "true" {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "CRITICAL",
			Category:       "Dev Mode",
			Message:        "Dev token authentication bypass is explicitly enabled via environment variable",
			Recommendation: "Set LIBRESERV_DEV_TOKEN_ENABLED=false or run in production mode",
		})
		result.Passed = false
	}
}

func validateCORS(cfg *config.Config, result *ValidationResult) {
	if len(cfg.CORS.AllowedOrigins) == 0 {
		severity := "MEDIUM"
		if result.IsDevMode {
			severity = "HIGH"
		}
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       severity,
			Category:       "CORS",
			Message:        "CORS allowed_origins is empty, defaulting to wildcard (*)",
			Recommendation: "Explicitly configure allowed_origins with specific domains",
		})
		if result.IsDevMode {
			result.Passed = false
		}
	} else {
		for _, origin := range cfg.CORS.AllowedOrigins {
			if origin == "*" {
				result.Issues = append(result.Issues, SecurityIssue{
					Severity:       "HIGH",
					Category:       "CORS",
					Message:        "CORS allowed_origins contains wildcard (*) which allows any origin",
					Recommendation: "Replace wildcard with specific domain patterns",
				})
				result.Passed = false
				break
			}
		}
	}
}

func validateSecrets(cfg *config.Config, result *ValidationResult) {
	if cfg.Auth.JWTSecret == "" {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "HIGH",
			Category:       "Authentication",
			Message:        "JWT secret is not configured",
			Recommendation: "Set auth.jwt_secret in config or LIBRESERV_AUTH_JWT_SECRET environment variable",
		})
		result.Passed = false
	} else if isLikelyHardcoded(cfg.Auth.JWTSecret) {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "MEDIUM",
			Category:       "Authentication",
			Message:        "JWT secret appears to be hardcoded in config file",
			Recommendation: "Use LIBRESERV_AUTH_JWT_SECRET environment variable for secrets",
		})
	}

	if cfg.Auth.CSRFSecret == "" {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "HIGH",
			Category:       "CSRF",
			Message:        "CSRF secret is not configured",
			Recommendation: "Set auth.csrf_secret in config or LIBRESERV_AUTH_CSRF_SECRET environment variable",
		})
		result.Passed = false
	} else if isLikelyHardcoded(cfg.Auth.CSRFSecret) {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "MEDIUM",
			Category:       "CSRF",
			Message:        "CSRF secret appears to be hardcoded in config file",
			Recommendation: "Use LIBRESERV_AUTH_CSRF_SECRET environment variable for secrets",
		})
	}
}

func validateNetworkBindings(cfg *config.Config, result *ValidationResult) {
	if cfg.Server.Host == "0.0.0.0" && result.IsDevMode {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "MEDIUM",
			Category:       "Network",
			Message:        "Server binding to all interfaces (0.0.0.0) in development mode",
			Recommendation: "Consider binding to localhost (127.0.0.1) for development",
		})
	}
}

func validateLogging(cfg *config.Config, result *ValidationResult) {
	if strings.ToLower(cfg.Logging.Level) == "debug" && result.IsDevMode {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "MEDIUM",
			Category:       "Logging",
			Message:        "Debug logging is enabled",
			Recommendation: "Use 'info' or 'warn' level in production",
		})
	}
}

func validateDocker(cfg *config.Config, result *ValidationResult) {
	if cfg.Docker.Method == "tcp" {
		severity := "HIGH"
		if result.IsDevMode {
			severity = "CRITICAL"
		}
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       severity,
			Category:       "Docker",
			Message:        "Docker connection via TCP without TLS",
			Recommendation: "Use Unix socket or SSH method, or enable TLS for TCP connections",
		})
		result.Passed = false
	}
}

func validateCSRF(cfg *config.Config, result *ValidationResult) {
	if cfg.Auth.CSRFSecret != "" && len(cfg.Auth.CSRFSecret) < 32 {
		result.Issues = append(result.Issues, SecurityIssue{
			Severity:       "HIGH",
			Category:       "CSRF",
			Message:        "CSRF secret is shorter than 32 bytes",
			Recommendation: "Use a cryptographically secure secret of at least 32 bytes",
		})
		result.Passed = false
	}
}

func isLikelyHardcoded(secret string) bool {
	if len(secret) < 32 {
		return false
	}

	commonPatterns := []string{
		"changeme",
		"password",
		"secret",
		"your-",
		"replace",
		"example",
		"default",
		"test",
	}

	secretLower := strings.ToLower(secret)
	for _, pattern := range commonPatterns {
		if strings.Contains(secretLower, pattern) {
			return true
		}
	}

	base64Regex := regexp.MustCompile(`^[A-Za-z0-9+/]+=*$`)
	if base64Regex.MatchString(secret) && len(secret) == 44 {
		return false
	}

	return false
}

func PrintSecurityBanner(result *ValidationResult) {
	if result.IsDevMode {
		fmt.Fprintln(os.Stderr, DevModeWarning)
		warningLogger.Warn("Development mode is active with security implications")
	}

	if len(result.Issues) > 0 {
		fmt.Fprintln(os.Stderr, InsecureConfigWarning)
		for _, issue := range result.Issues {
			warningLogger.Warn(fmt.Sprintf("[%s] %s: %s", issue.Severity, issue.Category, issue.Message),
				"recommendation", issue.Recommendation)
		}
		fmt.Fprintln(os.Stderr, "╚═══════════════════════════════════════════════════════════════════════╝")
	}

	if result.Passed {
		infoLogger.Info("Security validation passed", "mode", "production-ready")
	}
}

func ValidateProductionReadiness() error {
	result := ValidateConfig()

	PrintSecurityBanner(result)

	if result.IsDevMode {
		cfg := config.Get()

		if os.Getenv("LIBRESERV_INSECURE_DEV") == "true" {
			warningLogger.Warn("Insecure development mode explicitly enabled via LIBRESERV_INSECURE_DEV=true")
			return nil
		}

		if IsLoopback(cfg.Server.Host) {
			warningLogger.Warn("Running in development mode on localhost - security checks relaxed for local development")
			return nil
		}

		allowProductionDevMode := os.Getenv("LIBRESERV_ALLOW_DEV_MODE_IN_PRODUCTION")
		if allowProductionDevMode == "true" {
			warningLogger.Warn("Development mode explicitly enabled in non-local environment")
			return nil
		}

		return fmt.Errorf("server is in development mode which is not suitable for production use. Set server.mode to 'production' or:\n  - For local development: Set LIBRESERV_INSECURE_DEV=true (acknowledge risks)\n  - For isolated networks: Set LIBRESERV_ALLOW_DEV_MODE_IN_PRODUCTION=true")
	}

	failedCritical := false
	for _, issue := range result.Issues {
		if issue.Severity == "CRITICAL" {
			failedCritical = true
			break
		}
	}

	if failedCritical {
		return fmt.Errorf("critical security issues detected. Please review the warnings above")
	}

	return nil
}

func IsLoopback(host string) bool {
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}
