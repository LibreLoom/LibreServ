package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

type proxyServer struct {
	addr   string
	client *bleClient
	logger *slog.Logger
}

func newProxyServer(addr string, client *bleClient) *proxyServer {
	return &proxyServer{addr: addr, client: client, logger: slog.Default()}
}

func (p *proxyServer) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", p.handle)
	p.logger.Info("Starting local HTTP proxy", "addr", p.addr)
	return http.ListenAndServe(p.addr, mux)
}

func (p *proxyServer) handle(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Could not read request body", http.StatusBadRequest)
		return
	}
	_ = r.Body.Close()

	headers := make(map[string]string)
	for k, vv := range r.Header {
		if len(vv) > 0 {
			headers[k] = stringsJoin(vv, ", ")
		}
	}

	req := proxyRequest{
		ID:      generateID(),
		Method:  r.Method,
		Path:    r.URL.RequestURI(),
		Headers: headers,
		Body:    base64.StdEncoding.EncodeToString(body),
		Chunk:   0,
		Final:   true,
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	resp, err := p.client.doRequest(ctx, req)
	if err != nil {
		p.logger.Warn("proxy request failed", "error", err, "path", req.Path)
		http.Error(w, fmt.Sprintf("Could not reach LibreServ over Bluetooth. %v", err), http.StatusGatewayTimeout)
		return
	}

	if resp.Headers != nil {
		for k, v := range resp.Headers {
			w.Header().Set(k, v)
		}
	}
	if resp.Status != 0 {
		w.WriteHeader(resp.Status)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	bodyBytes, _ := base64.StdEncoding.DecodeString(resp.Body)
	if _, err := w.Write(bodyBytes); err != nil {
		p.logger.Warn("failed to write response", "error", err)
	}
}

func stringsJoin(a []string, sep string) string {
	if len(a) == 0 {
		return ""
	}
	s := a[0]
	for i := 1; i < len(a); i++ {
		s += sep + a[i]
	}
	return s
}
