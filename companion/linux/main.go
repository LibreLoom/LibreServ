package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
)

func main() {
	var (
		setupCode  = flag.String("code", "", "LibreServ setup code (6 characters)")
		proxyAddr  = flag.String("addr", "127.0.0.1:18080", "Local proxy address")
		noBrowser  = flag.Bool("no-browser", false, "Do not open a browser automatically")
	)
	flag.Parse()

	if *setupCode == "" {
		fmt.Fprintln(os.Stderr, "Usage: libreserv-ble-companion -code=ABCDEF")
		fmt.Fprintln(os.Stderr, "The setup code is printed on your LibreServ device.")
		os.Exit(1)
	}

	logger := slog.Default()

	ble := newBLEClient(strings.ToUpper(*setupCode), logger)
	if err := ble.connect(); err != nil {
		logger.Error("Failed to connect to LibreServ via BLE", "error", err)
		os.Exit(1)
	}
	defer func() {
		_ = ble.disconnect()
	}()

	proxy := newProxyServer(*proxyAddr, ble, logger)
	go func() {
		if err := proxy.Start(); err != nil {
			logger.Error("Proxy server failed", "error", err)
			os.Exit(1)
		}
	}()

	url := "http://" + *proxyAddr
	if !*noBrowser {
		logger.Info("Opening browser", "url", url)
		_ = openBrowser(url)
	}
	logger.Info("LibreServ is available over Bluetooth", "url", url)

	// Block until interrupted
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	logger.Info("Shutting down")
}

func openBrowser(url string) error {
	cmd := exec.Command("xdg-open", url)
	return cmd.Start()
}
