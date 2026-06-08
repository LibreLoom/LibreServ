//go:build libreserv_ble

// Package bluetooth implements an always-on BLE GATT peripheral that acts
// as an HTTP proxy for the LibreServ Web UI. A companion app connects over BLE
// and proxies all HTTP requests through the GATT service, allowing full Web UI
// access even when mDNS or routing is unavailable.
package bluetooth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"

	"tinygo.org/x/bluetooth"
)

func mustParseUUID(s string) bluetooth.UUID {
	u, err := bluetooth.ParseUUID(s)
	if err != nil {
		panic(err)
	}
	return u
}

var (
	serviceUUID    = mustParseUUID("5a494c42-6572-6572-7600-000000000000")
	charAuth       = mustParseUUID("5a494c42-6572-6572-7600-000000000002")
	charAuthStatus = mustParseUUID("5a494c42-6572-6572-7600-000000000003")
	charProxyReq   = mustParseUUID("5a494c42-6572-6572-7600-000000000004")
	charProxyResp  = mustParseUUID("5a494c42-6572-6572-7600-000000000005")
)

type proxyServer struct {
	setupCode string
	logger    *slog.Logger

	adapter        *bluetooth.Adapter
	adv            *bluetooth.Advertisement
	authStatusChar *bluetooth.Characteristic
	proxyRespChar  *bluetooth.Characteristic

	mu          sync.RWMutex
	authed      bool
	connected   bool
	pendingReqs map[string]*pendingReq

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

type pendingReq struct {
	method  string
	path    string
	headers map[string]string
	bodyBuf *bytes.Buffer
	started time.Time
}

func newProxyServer(setupCode string, logger *slog.Logger) *proxyServer {
	return &proxyServer{
		setupCode:   setupCode,
		logger:      logger,
		pendingReqs: make(map[string]*pendingReq),
	}
}

func (s *proxyServer) Start() error {
	s.adapter = bluetooth.DefaultAdapter

	s.ctx, s.cancel = context.WithCancel(context.Background())

	if err := s.adapter.Enable(); err != nil {
		return fmt.Errorf("bluetooth enable: %w", err)
	}

	s.adapter.SetConnectHandler(func(device bluetooth.Device, connected bool) {
		s.mu.Lock()
		if connected {
			s.connected = true
			s.authed = false
			s.clearPendingRequestsLocked()
			s.logger.Info("BLE client connected", "address", device.Address.String())
		} else {
			s.connected = false
			s.authed = false
			s.clearPendingRequestsLocked()
			s.logger.Info("BLE client disconnected", "address", device.Address.String())
		}
		s.mu.Unlock()
	})

	var authStatusHnd bluetooth.Characteristic
	var proxyRespHnd bluetooth.Characteristic

	svc := bluetooth.Service{
		UUID: serviceUUID,
		Characteristics: []bluetooth.CharacteristicConfig{
			{
				UUID:       charAuth,
				Flags:      bluetooth.CharacteristicWritePermission,
				WriteEvent: s.handleAuthWrite,
			},
			{
				UUID:   charAuthStatus,
				Flags:  bluetooth.CharacteristicReadPermission | bluetooth.CharacteristicNotifyPermission,
				Handle: &authStatusHnd,
				Value:  []byte(`{"ok":false}`),
			},
			{
				UUID:       charProxyReq,
				Flags:      bluetooth.CharacteristicWritePermission,
				WriteEvent: s.handleProxyReqWrite,
			},
			{
				UUID:   charProxyResp,
				Flags:  bluetooth.CharacteristicReadPermission | bluetooth.CharacteristicNotifyPermission,
				Handle: &proxyRespHnd,
				Value:  []byte{},
			},
		},
	}

	if err := s.adapter.AddService(&svc); err != nil {
		return fmt.Errorf("gatt add service: %w", err)
	}

	s.authStatusChar = &authStatusHnd
	s.proxyRespChar = &proxyRespHnd

	s.adv = s.adapter.DefaultAdvertisement()
	if err := s.adv.Configure(bluetooth.AdvertisementOptions{
		LocalName:    s.advertiseName(),
		ServiceUUIDs: []bluetooth.UUID{serviceUUID},
	}); err != nil {
		return fmt.Errorf("advertisement configure: %w", err)
	}

	if err := s.adv.Start(); err != nil {
		return fmt.Errorf("advertisement start: %w", err)
	}

	s.wg.Add(1)
	go s.pendingReqTimeoutLoop()

	s.logger.Info("BLE proxy advertising", "name", s.advertiseName(), "uuid", serviceUUID.String())
	return nil
}

func (s *proxyServer) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.adv != nil {
		if err := s.adv.Stop(); err != nil {
			s.logger.Warn("BLE advertisement stop failed", "error", err)
		}
	}
	s.wg.Wait()
}

func (s *proxyServer) advertiseName() string {
	addr, err := s.adapter.Address()
	if err != nil {
		return "LibreServ"
	}
	mac := addr.MAC
	if len(mac) >= 2 {
		return "LibreServ-" + fmt.Sprintf("%02x%02x", mac[len(mac)-2], mac[len(mac)-1])
	}
	return "LibreServ"
}

func (s *proxyServer) handleAuthWrite(client bluetooth.Connection, offset int, value []byte) {
	code := string(value)
	s.mu.Lock()
	defer s.mu.Unlock()

	status := authStatus{
		OK:        false,
		Timestamp: time.Now().Unix(),
	}
	if code == s.setupCode {
		s.authed = true
		status.OK = true
		s.logger.Info("BLE auth succeeded")
	} else {
		s.authed = false
		status.Message = "The code you entered does not match. Check the setup code printed on your device and try again."
		s.logger.Warn("BLE auth failed", "reason", status.Message)
	}

	j, _ := json.Marshal(status)
	if s.authStatusChar != nil {
		_, _ = s.authStatusChar.Write(j)
	}
}

func (s *proxyServer) handleProxyReqWrite(client bluetooth.Connection, offset int, value []byte) {
	s.mu.RLock()
	authed := s.authed
	s.mu.RUnlock()
	if !authed {
		s.sendProxyError("", http.StatusForbidden, "not authenticated")
		return
	}

	var req proxyRequest
	if err := json.Unmarshal(value, &req); err != nil {
		s.sendProxyError("", http.StatusBadRequest, "The companion app sent a request the server did not understand. Please restart the app and try again.")
		return
	}

	if req.Chunk == 0 && req.Final {
		body, _ := base64.StdEncoding.DecodeString(req.Body)
		s.executeHTTP(req.ID, req.Method, req.Path, req.Headers, bytes.NewReader(body))
		return
	}

	if req.Chunk == 0 && !req.Final {
		body, _ := base64.StdEncoding.DecodeString(req.Body)
		s.mu.Lock()
		s.pendingReqs[req.ID] = &pendingReq{
			method:  req.Method,
			path:    req.Path,
			headers: req.Headers,
			bodyBuf: bytes.NewBuffer(body),
			started: time.Now(),
		}
		s.mu.Unlock()
		return
	}

	// Continuation chunk (Chunk > 0, or Final with Chunk > 0)
	s.mu.Lock()
	p, ok := s.pendingReqs[req.ID]
	if !ok {
		s.mu.Unlock()
		s.sendProxyError(req.ID, http.StatusBadRequest, "The server lost track of this request. Please send it again.")
		return
	}
	body, _ := base64.StdEncoding.DecodeString(req.Body)
	p.bodyBuf.Write(body)

	if req.Final {
		delete(s.pendingReqs, req.ID)
		method, path, headers := p.method, p.path, p.headers
		buf := bytes.NewBuffer(p.bodyBuf.Bytes())
		s.mu.Unlock()
		s.executeHTTP(req.ID, method, path, headers, buf)
		return
	}
	s.mu.Unlock()
}

// dispatchHTTP routes the request through the internal chi router and returns
// the response as a slice of proxyResponse chunks. It does not interact with BLE.
func (s *proxyServer) dispatchHTTP(method, path string, headers map[string]string, body io.Reader) ([]proxyResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	httpReq, err := http.NewRequest(method, "http://localhost"+path, body)
	if err != nil {
		return nil, err
	}
	httpReq = httpReq.WithContext(ctx)
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	router := getRouter()
	if router == nil {
		return nil, fmt.Errorf("router not ready")
	}

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httpReq)

	resp := rec.Result()
	h := resp.Header
	hdrMap := make(map[string]string, len(h))
	for k := range h {
		hdrMap[k] = h.Get(k)
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	const maxChunk = 300 // ~300 raw bytes → ~400 base64 → fits comfortably in 512-byte BLE MTU
	chunks := chunkBytes(respBody, maxChunk)

	var out []proxyResponse
	for i, chunk := range chunks {
		pr := proxyResponse{
			Status:     resp.StatusCode,
			StatusText: resp.Status,
			Headers:    hdrMap,
			Body:       base64.StdEncoding.EncodeToString(chunk),
			Chunk:      i,
			Final:      i == len(chunks)-1,
		}
		if i > 0 {
			pr.Status = 0
			pr.StatusText = ""
			pr.Headers = nil
		}
		out = append(out, pr)
	}
	return out, nil
}

func (s *proxyServer) executeHTTP(id, method, path string, headers map[string]string, body io.Reader) {
	chunks, err := s.dispatchHTTP(method, path, headers, body)
	if err != nil {
		s.sendProxyError(id, http.StatusBadRequest, "Could not understand that request. Please check the address and try again.")
		return
	}
	for i := range chunks {
		chunks[i].ID = id
		j, _ := json.Marshal(chunks[i])
		if s.proxyRespChar != nil {
			_, _ = s.proxyRespChar.Write(j)
		}
	}
}

func (s *proxyServer) sendProxyError(id string, status int, message string) {
	pr := proxyResponse{
		ID:     id,
		Status: status,
		Body:   base64.StdEncoding.EncodeToString([]byte(message)),
		Final:  true,
	}
	j, _ := json.Marshal(pr)
	if s.proxyRespChar != nil {
		_, _ = s.proxyRespChar.Write(j)
	}
}

func (s *proxyServer) pendingReqTimeoutLoop() {
	defer s.wg.Done()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			var timedOut []string
			s.mu.Lock()
			now := time.Now()
			for id, p := range s.pendingReqs {
				if now.Sub(p.started) > 60*time.Second {
					timedOut = append(timedOut, id)
				}
			}
			for _, id := range timedOut {
				delete(s.pendingReqs, id)
			}
			s.mu.Unlock()
			for _, id := range timedOut {
				s.sendProxyError(id, http.StatusRequestTimeout, "request timed out")
			}
		}
	}
}

func (s *proxyServer) clearPendingRequestsLocked() {
	s.pendingReqs = make(map[string]*pendingReq)
}
