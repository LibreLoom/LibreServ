package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/setuphub"
)

const (
	setupGuessMax    = 8
	setupGuessWindow = 15 * 60
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: originAllowed,
}

func rejectHello(conn *websocket.Conn, message string) {
	_ = conn.WriteJSON(setuphub.Message{Type: "error", Message: message})
}

func clientKeyToken(norm string) string {
	return "tok:" + security.HashToken(norm)
}

func (h OnboardingHandler) SetupWS(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	_, raw, err := conn.ReadMessage()
	if err != nil {
		return
	}
	ipKey := clientKeyIP(r)
	if !allowGuess(h.DB, ipKey, setupGuessMax, setupGuessWindow) {
		rejectHello(conn, "Too many tries from this network. Wait a few minutes, then try again.")
		return
	}
	var hello setuphub.Message
	if err := json.Unmarshal(raw, &hello); err != nil || hello.Type != "hello" {
		rejectHello(conn, "Luna must say hello with its setup code.")
		return
	}
	norm := security.NormalizeToken(hello.Token)
	if norm == "" {
		rejectHello(conn, "Missing setup code.")
		return
	}
	tok, ok := lookupIssued(h.DB, norm)
	if !ok || tok.Status != "issued" {
		_ = allowGuess(h.DB, clientKeyToken(norm), setupGuessMax, setupGuessWindow)
		rejectHello(conn, "unknown")
		return
	}
	source := hello.Source
	if source == "" {
		source = "anonymous"
	}
	sock := setuphub.NewSocket(tok.Hash, ClientIP(r), source, hello.LocalPort)
	if err := h.Hub.Register(sock); err != nil {
		if errors.Is(err, setuphub.ErrAlreadyLive) {
			rejectHello(conn, "This Luna is already talking to us. Wait a moment and try again.")
			return
		}
		rejectHello(conn, "Too many Lunas are waiting. Try again in a few minutes.")
		return
	}
	defer h.Hub.Drop(tok.Hash)

	_ = conn.WriteJSON(setuphub.Message{Type: "accepted", Kind: tok.Kind})

	var sessID string
	_ = h.DB.QueryRow(`SELECT id FROM setup_sessions WHERE token_hash = ? AND status IN ('waiting_device','attached') ORDER BY created_at DESC LIMIT 1`, tok.Hash).Scan(&sessID)
	if sessID != "" {
		_, _ = h.DB.Exec(`UPDATE setup_sessions SET status = 'attached' WHERE id = ?`, sessID)
		_ = conn.WriteJSON(setuphub.Message{Type: "attached", SessionID: sessID, Kind: tok.Kind})
	} else {
		_ = conn.WriteJSON(setuphub.Message{Type: "waiting_for_website", Waiting: true})
	}

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				sock.Close()
				return
			}
		}
	}()

	for {
		select {
		case <-sock.Closed():
			return
		case msg := <-sock.Recv():
			if err := conn.WriteJSON(msg); err != nil {
				return
			}
			if msg.Type == "claimed" {
				return
			}
		}
	}
}

func NormalizeAuthToken(raw string) string {
	return security.NormalizeToken(strings.TrimSpace(raw))
}
