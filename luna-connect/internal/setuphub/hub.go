package setuphub

import (
	"sync"
	"time"
)

const (
	SessionTTL           = 15 * time.Minute
	MaxUnclaimedGlobal   = 200
	MaxUnclaimedPerIP    = 8
	MaxDevicesPerAccount = 2
)

type Message struct {
	Type        string `json:"type"`
	Kind        string `json:"kind,omitempty"`
	SessionID   string `json:"session_id,omitempty"`
	DeviceToken string `json:"device_token,omitempty"`
	Hostname    string `json:"hostname,omitempty"`
	TunnelToken string `json:"tunnel_token,omitempty"`
	SetupSecret string `json:"setup_secret,omitempty"`
	Subdomain   string `json:"subdomain,omitempty"`
	Message     string `json:"message,omitempty"`
	LocalPort   int    `json:"local_port,omitempty"`
	Token       string `json:"token,omitempty"`
	Source      string `json:"source,omitempty"`
	Waiting     bool   `json:"waiting,omitempty"`
}

type Socket struct {
	TokenHash string
	IP        string
	Source    string
	LocalPort int
	send      chan Message
	closed    chan struct{}
	mu        sync.Mutex
	dead      bool
}

func NewSocket(tokenHash, ip, source string, localPort int) *Socket {
	if localPort <= 0 {
		localPort = 8090
	}
	if source == "" {
		source = "anonymous"
	}
	return &Socket{
		TokenHash: tokenHash,
		IP:        ip,
		Source:    source,
		LocalPort: localPort,
		send:      make(chan Message, 16),
		closed:    make(chan struct{}),
	}
}

func (s *Socket) Send(msg Message) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return false
	}
	select {
	case s.send <- msg:
		return true
	default:
		return false
	}
}

func (s *Socket) Recv() <-chan Message { return s.send }

func (s *Socket) Closed() <-chan struct{} { return s.closed }

func (s *Socket) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return
	}
	s.dead = true
	close(s.closed)
}

type Hub struct {
	mu             sync.Mutex
	sockets        map[string]*Socket // token hash → live unclaimed socket
	unclaimedByIP  map[string]int
	unclaimedTotal int
}

func New() *Hub {
	return &Hub{
		sockets:       make(map[string]*Socket),
		unclaimedByIP: make(map[string]int),
	}
}

var (
	ErrUnknownToken   = errText("unknown token")
	ErrSocketCap      = errText("too many waiting Lunas")
	ErrNoSocket       = errText("no live luna")
	ErrAlreadyClaimed = errText("already claimed")
)

type errText string

func (e errText) Error() string { return string(e) }

func (h *Hub) Register(sock *Socket) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.unclaimedTotal >= MaxUnclaimedGlobal {
		return ErrSocketCap
	}
	if h.unclaimedByIP[sock.IP] >= MaxUnclaimedPerIP {
		return ErrSocketCap
	}
	if old, ok := h.sockets[sock.TokenHash]; ok {
		old.Close()
		h.unclaimedByIP[old.IP]--
		if h.unclaimedByIP[old.IP] <= 0 {
			delete(h.unclaimedByIP, old.IP)
		}
		h.unclaimedTotal--
	}
	h.sockets[sock.TokenHash] = sock
	h.unclaimedByIP[sock.IP]++
	h.unclaimedTotal++
	return nil
}

func (h *Hub) Drop(tokenHash string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.dropLocked(tokenHash)
}

func (h *Hub) dropLocked(tokenHash string) {
	sock, ok := h.sockets[tokenHash]
	if !ok {
		return
	}
	sock.Close()
	delete(h.sockets, tokenHash)
	h.unclaimedByIP[sock.IP]--
	if h.unclaimedByIP[sock.IP] <= 0 {
		delete(h.unclaimedByIP, sock.IP)
	}
	h.unclaimedTotal--
}

func (h *Hub) Live(tokenHash string) *Socket {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sockets[tokenHash]
}

func (h *Hub) HasLive(tokenHash string) bool {
	return h.Live(tokenHash) != nil
}

func (h *Hub) Push(tokenHash string, msg Message) bool {
	sock := h.Live(tokenHash)
	if sock == nil {
		return false
	}
	return sock.Send(msg)
}

func (h *Hub) ClaimAndDrop(tokenHash string, msg Message) bool {
	h.mu.Lock()
	sock := h.sockets[tokenHash]
	h.mu.Unlock()
	if sock == nil {
		return false
	}
	ok := sock.Send(msg)
	h.Drop(tokenHash)
	return ok
}
