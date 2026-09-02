package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func main() {
	sqlitePath := flag.String("sqlite", envOr("LUNACONNECT_SQLITE_PATH", "/var/lib/luna-connect/luna-connect.db"), "path to existing SQLite database")
	postgresURL := flag.String("postgres", strings.TrimSpace(os.Getenv("LUNACONNECT_DATABASE_URL")), "postgres DSN (postgres://user:pass@host:5432/db?sslmode=disable)")
	dryRun := flag.Bool("dry-run", false, "validate connections and print row counts without writing")
	flag.Parse()

	if *postgresURL == "" {
		fmt.Fprintln(os.Stderr, "postgres URL required: set LUNACONNECT_DATABASE_URL or pass -postgres")
		os.Exit(2)
	}

	src, err := database.Open(*sqlitePath)
	if err != nil {
		slog.Error("open sqlite", "path", *sqlitePath, "error", err)
		os.Exit(1)
	}
	defer src.Close()

	dst, err := database.OpenFromConfig("postgres", "", *postgresURL)
	if err != nil {
		slog.Error("open postgres", "error", err)
		os.Exit(1)
	}
	defer dst.Close()

	if *dryRun {
		printCounts("sqlite", src)
		printCounts("postgres", dst)
		fmt.Println("dry-run complete — no rows copied")
		return
	}

	if err := database.MigrateSQLiteToPostgres(src, dst); err != nil {
		slog.Error("migrate failed", "error", err)
		os.Exit(1)
	}
	fmt.Println("migration complete")
	printCounts("postgres", dst)
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func printCounts(label string, db *database.DB) {
	fmt.Printf("--- %s ---\n", label)
	for _, table := range []string{
		"accounts", "devices", "backup_objects", "admin_accounts", "service_providers",
	} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			fmt.Printf("  %s: error: %v\n", table, err)
			continue
		}
		fmt.Printf("  %s: %d\n", table, n)
	}
}
