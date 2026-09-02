package handlers

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbeLunaHealth(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	prev := lunaHealthHTTPClient
	lunaHealthHTTPClient = &http.Client{
		Timeout: lunaHealthProbeTimeout,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // test-only self-signed cert
		},
	}
	defer func() { lunaHealthHTTPClient = prev }()

	host := strings.TrimPrefix(srv.URL, "https://")
	if !probeLunaHealth(host) {
		t.Fatal("expected health probe to succeed against test TLS server")
	}
	if probeLunaHealth("") {
		t.Fatal("empty hostname should not be reachable")
	}
	if probeLunaHealth("127.0.0.1:1") {
		t.Fatal("closed port should not be reachable")
	}
}
