package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/scheduler"
)

// Version info injected via ldflags at build time.
var (
	version   = "dev"
	gitCommit = "unknown"
	buildTime = "unknown"
)

func main() {
	healthFlag := flag.Bool("health", false, "run health check against the server and exit")
	flag.Parse()

	if *healthFlag {
		port := 8080
		if p := os.Getenv("CONNECT_SERVER_PORT"); p != "" {
			fmt.Sscanf(p, "%d", &port)
		}
		client := &http.Client{Timeout: 3 * time.Second}
		resp, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + "/healthz")
		if err != nil {
			os.Exit(1)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}

	cfgPath := os.Getenv("CONNECT_CONFIG")
	if cfgPath == "" {
		cfgPath = "configs/connect.yaml"
	}

	if err := config.Load(cfgPath); err != nil {
		if os.IsNotExist(err) {
			slog.Info("config file not found, using env defaults", "path", cfgPath)
		} else {
			slog.Error("failed to load config", "error", err)
			os.Exit(1)
		}
	}

	// Initialize Stripe SDK if billing is enabled
	if config.C.Stripe.Enabled {
		providers.InitStripe()
		slog.Info("stripe billing enabled")
	}

	db, err := database.Open(config.C.Database.URL)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := database.Migrate(db); err != nil {
		slog.Error("failed to migrate database", "error", err)
		os.Exit(1)
	}

	srv := api.NewServer(db)

	// Start the domain sync scheduler.
	schedulerInterval := 6 * time.Hour
	if d, err := time.ParseDuration(config.C.Scheduler.DomainSyncInterval); err == nil && d > 0 {
		schedulerInterval = d
	}
	registrarClient := providers.NewRegistrarClient(nil)
	billingSvc := billing.NewService(db)
	sched := scheduler.New(db, registrarClient, billingSvc, schedulerInterval)
	defer sched.Stop()
	sched.Start()

	addr := config.C.Server.Address
	port := config.C.Server.Port
	if port == 0 {
		port = 8080
	}
	bind := net.JoinHostPort(addr, strconv.Itoa(port))

	slog.Info("connect server starting", "address", bind, "version", version, "commit", gitCommit, "built", buildTime)
	if err := http.ListenAndServe(bind, srv.Router()); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
