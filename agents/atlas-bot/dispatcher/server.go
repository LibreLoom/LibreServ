package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

type server struct {
	cfg    config
	client *http.Client

	ownersMu  sync.Mutex
	owners    map[string]struct{}
	ownersAt  time.Time

	inflightMu sync.Mutex
	inflight   map[string]struct{}
}

func newServer(cfg config) *server {
	return &server{
		cfg:      cfg,
		client:   &http.Client{Timeout: 30 * time.Second},
		inflight: map[string]struct{}{},
	}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("POST /webhook", s.handleWebhook)
	return mux
}

func (s *server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}
	if !verifySignature(s.cfg.WebhookSecret, body, r) {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}
	event := eventName(r.Header)
	var p hookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	job, ok := s.extractJob(event, p)
	if !ok {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("ignored\n"))
		return
	}
	key := fmt.Sprintf("%s/%s#%d", job.Owner, job.Repo, job.Number)
	s.inflightMu.Lock()
	_, busy := s.inflight[key]
	if !busy {
		s.inflight[key] = struct{}{}
	}
	s.inflightMu.Unlock()
	if busy {
		_ = s.postComment(r.Context(), job, "Already cooking on this issue \u2014 wait for that run to finish, then mention me again.")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("busy\n"))
		return
	}

	go func() {
		defer func() {
			s.inflightMu.Lock()
			delete(s.inflight, key)
			s.inflightMu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), s.cfg.JobTimeout+2*time.Minute)
		defer cancel()
		s.runJob(ctx, job)
	}()
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte("accepted\n"))
}

func (s *server) runJob(ctx context.Context, job job) {
	ok, err := s.senderIsOwner(ctx, job.Sender)
	if err != nil {
		log.Printf("owners lookup failed: %v", err)
		_ = s.postComment(ctx, job, "Could not check Owners membership (API error). Not starting a job.")
		return
	}
	if !ok {
		_ = s.postComment(ctx, job, notOwnersMessage)
		return
	}
	if err := s.postComment(ctx, job, s.cfg.Cooking); err != nil {
		log.Printf("cooking comment failed: %v", err)
		return
	}
	result, runErr := s.runSandbox(ctx, job)
	if runErr != nil {
		log.Printf("sandbox: %v", runErr)
		msg := "Job failed in the sandbox.\n\n```\n" + trim(runErr.Error(), 3500) + "\n```"
		if result != "" {
			msg = result + "\n\n---\n" + msg
		}
		_ = s.postComment(ctx, job, msg)
		return
	}
	if strings.TrimSpace(result) == "" {
		result = "Done, but I didn't write a summary. Check the branch/PR if one was opened."
	}
	_ = s.postComment(ctx, job, trim(result, maxCommentBytes))
}
