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
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
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

func TestProbeDomainProvisioned(t *testing.T) {
	// Status 530 (Cloudflare Error 1033 - tunnel ingress waiting for daemon)
	srv530 := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(530)
	}))
	defer srv530.Close()

	// Status 502 Bad Gateway
	srv502 := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv502.Close()

	// Status 200 OK
	srv200 := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv200.Close()

	// Status 404 (unexpected error, domain not provisioned for tunnel)
	srv404 := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv404.Close()

	prev := lunaHealthHTTPClient
	lunaHealthHTTPClient = &http.Client{
		Timeout: lunaHealthProbeTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // test-only self-signed cert
		},
	}
	defer func() { lunaHealthHTTPClient = prev }()

	host530 := strings.TrimPrefix(srv530.URL, "https://")
	if !probeDomainProvisioned(host530) {
		t.Fatal("expected status 530 to indicate domain is provisioned and hitting Cloudflare edge")
	}

	host502 := strings.TrimPrefix(srv502.URL, "https://")
	if !probeDomainProvisioned(host502) {
		t.Fatal("expected status 502 to indicate domain is provisioned and hitting Cloudflare edge")
	}

	host200 := strings.TrimPrefix(srv200.URL, "https://")
	if !probeDomainProvisioned(host200) {
		t.Fatal("expected status 200 to indicate domain is provisioned and serving")
	}

	host404 := strings.TrimPrefix(srv404.URL, "https://")
	if probeDomainProvisioned(host404) {
		t.Fatal("expected status 404 not to count as provisioned tunnel edge")
	}

	if probeDomainProvisioned("") {
		t.Fatal("empty hostname should not be provisioned")
	}

	if probeDomainProvisioned("127.0.0.1:1") {
		t.Fatal("closed port should not be provisioned")
	}
}

func TestProbeLunaHealthRejectsRedirect(t *testing.T) {
	internalHit := false
	internal := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		internalHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer internal.Close()

	redir := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, internal.URL+"/api/v1/health", http.StatusFound)
	}))
	defer redir.Close()

	prev := lunaHealthHTTPClient
	lunaHealthHTTPClient = &http.Client{
		Timeout: lunaHealthProbeTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // test-only self-signed cert
		},
	}
	defer func() { lunaHealthHTTPClient = prev }()

	host := strings.TrimPrefix(redir.URL, "https://")
	if probeLunaHealth(host) {
		t.Fatal("redirect response must not count as healthy")
	}
	if probeDomainProvisioned(host) {
		t.Fatal("redirect response must not count as provisioned")
	}
	if internalHit {
		t.Fatal("health client must not follow redirects to another host")
	}
}
