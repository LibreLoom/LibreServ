package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultAddr   = ":8443"
	sessionExpiry = 2 * time.Hour
	pingInterval  = 20 * time.Second
	writeWait     = 15 * time.Second
	readLimit     = 1 << 20 // 1MB per message
	tsSkew        = 5 * time.Minute
)

type relayServer struct {
	upgrader websocket.Upgrader
	sessions map[string]*session
	mu       sync.Mutex
	hmacKey  []byte
}

type session struct {
	id          string
	createdAt   time.Time
	device      *wsConn
	agent       *wsConn
	cancel      context.CancelFunc
	active      bool
	lastTouched time.Time
}

type wsConn struct {
	conn *websocket.Conn
	role string
	mu   sync.Mutex
}

func main() {
	addr := os.Getenv("RELAY_ADDR")
	if addr == "" {
		addr = defaultAddr
	}
	hmacKey := []byte(os.Getenv("RELAY_HMAC_SECRET"))
	if len(hmacKey) == 0 {
		log.Printf("warning: RELAY_HMAC_SECRET not set; connections are not authenticated")
	}

	srv := &relayServer{
		upgrader: websocket.Upgrader{
			ReadBufferSize:  8192,
			WriteBufferSize: 8192,
			CheckOrigin: func(r *http.Request) bool {
				// Cross-origin is expected for relay use; authentication is done via session code.
				return true
			},
		},
		sessions: make(map[string]*session),
		hmacKey:  hmacKey,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", srv.handleWS)

	server := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("support-relay listening on %s", addr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("relay server failed: %v", err)
	}
}

func (r *relayServer) handleWS(w http.ResponseWriter, req *http.Request) {
	role := req.URL.Query().Get("role")
	if role != "device" && role != "agent" {
		http.Error(w, "role must be device or agent", http.StatusBadRequest)
		return
	}
	code := req.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "code is required", http.StatusBadRequest)
		return
	}
	nonce := req.URL.Query().Get("nonce")
	sig := req.URL.Query().Get("sig")
	ts := req.URL.Query().Get("ts")
	if len(r.hmacKey) > 0 {
		if nonce == "" || sig == "" || ts == "" {
			http.Error(w, "nonce, sig, ts required", http.StatusUnauthorized)
			return
		}
		if !validateSig(r.hmacKey, code, role, nonce, ts, sig) {
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
		if !tsFresh(ts) {
			http.Error(w, "timestamp stale", http.StatusUnauthorized)
			return
		}
	}

	conn, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	ws := &wsConn{conn: conn, role: role}
	ws.conn.SetReadLimit(readLimit)
	_ = ws.conn.SetReadDeadline(time.Now().Add(2 * pingInterval))
	ws.conn.SetPongHandler(func(string) error {
		_ = ws.conn.SetReadDeadline(time.Now().Add(2 * pingInterval))
		return nil
	})

	sess := r.attach(code, ws)
	if sess == nil {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session rejected"), time.Now().Add(writeWait))
		_ = conn.Close()
		return
	}

	log.Printf("connected %s for session %s", role, code)
}

func (r *relayServer) attach(code string, ws *wsConn) *session {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Clean expired sessions
	now := time.Now()
	for k, s := range r.sessions {
		if now.Sub(s.lastTouched) > sessionExpiry {
			s.closeLocked("expired")
			delete(r.sessions, k)
		}
	}

	s, ok := r.sessions[code]
	if !ok {
		s = &session{
			id:          code,
			createdAt:   now,
			lastTouched: now,
			active:      true,
		}
		r.sessions[code] = s
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	if ws.role == "device" {
		if s.device != nil {
			_ = ws.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "device already connected"), time.Now().Add(writeWait))
			_ = ws.conn.Close()
			return nil
		}
		s.device = ws
	} else {
		if s.agent != nil {
			_ = ws.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "agent already connected"), time.Now().Add(writeWait))
			_ = ws.conn.Close()
			return nil
		}
		s.agent = ws
	}

	if s.device != nil && s.agent != nil {
		go s.run(ctx, r, ws.conn.RemoteAddr())
	}

	return s
}

func (s *session) run(ctx context.Context, r *relayServer, remoteAddr net.Addr) {
	log.Printf("bridging session %s", s.id)
	defer func() {
		r.mu.Lock()
		delete(r.sessions, s.id)
		r.mu.Unlock()
		s.close("session finished")
	}()

	pump := func(src, dst *wsConn, label string) {
		defer func() {
			if dst != nil {
				_ = dst.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "peer closed"), time.Now().Add(writeWait))
			}
			s.cancel()
		}()
		for {
			mt, data, err := src.conn.ReadMessage()
			if err != nil {
				return
			}
			if dst == nil {
				return
			}
			dst.mu.Lock()
			_ = dst.conn.SetWriteDeadline(time.Now().Add(writeWait))
			err = dst.conn.WriteMessage(mt, data)
			dst.mu.Unlock()
			if err != nil {
				return
			}
			s.lastTouched = time.Now()
		}
	}

	// Heartbeats
	go func(c *wsConn) {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.mu.Lock()
				_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
				err := c.conn.WriteMessage(websocket.PingMessage, []byte{})
				c.mu.Unlock()
				if err != nil {
					s.cancel()
					return
				}
			}
		}
	}(s.device)
	go func(c *wsConn) {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.mu.Lock()
				_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
				err := c.conn.WriteMessage(websocket.PingMessage, []byte{})
				c.mu.Unlock()
				if err != nil {
					s.cancel()
					return
				}
			}
		}
	}(s.agent)

	go pump(s.device, s.agent, "device->agent")
	go pump(s.agent, s.device, "agent->device")

	<-ctx.Done()
	log.Printf("session %s closed (remote %v)", s.id, remoteAddr)
}

func (s *session) close(reason string) {
	s.closeLocked(reason)
}

func (s *session) closeLocked(reason string) {
	if !s.active {
		return
	}
	s.active = false
	if s.cancel != nil {
		s.cancel()
	}
	if s.device != nil {
		_ = s.device.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason), time.Now().Add(writeWait))
		_ = s.device.conn.Close()
	}
	if s.agent != nil {
		_ = s.agent.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason), time.Now().Add(writeWait))
		_ = s.agent.conn.Close()
	}
}

func validateSig(key []byte, code, role, nonce, ts, sig string) bool {
	if len(key) == 0 {
		return true
	}
	mac := hmac.New(sha256.New, key)
	io.WriteString(mac, strings.Join([]string{code, role, nonce, ts}, "|"))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(sig))
}

func tsFresh(ts string) bool {
	parsed, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false
	}
	t := time.Unix(parsed, 0)
	diff := time.Since(t)
	if diff < 0 {
		diff = -diff
	}
	return diff <= tsSkew
}
