package publish

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTransferClientAllowsSlowSteadyDownload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 15; i++ { // ~600ms in total, far past the idle limit
			w.Write([]byte("chunk"))
			w.(http.Flusher).Flush()
			time.Sleep(40 * time.Millisecond)
		}
	}))
	defer srv.Close()
	c := NewTransferClient(TransferOptions{Idle: 250 * time.Millisecond})
	if c.Timeout != 0 {
		t.Fatalf("transfer client has an overall timeout %s", c.Timeout)
	}
	// a client with a whole-request limit of the same size would fail
	short := &http.Client{Timeout: 250 * time.Millisecond}
	if resp, err := short.Get(srv.URL); err == nil {
		_, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		if err == nil {
			t.Fatal("the slow server is not slow enough to prove anything")
		}
	}
	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil || len(b) != 15*5 {
		t.Fatalf("read %d bytes: %v", len(b), err)
	}
}

func TestTransferClientAbortsStalledDownload(t *testing.T) {
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("start"))
		w.(http.Flusher).Flush()
		select {
		case <-done:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(done)
	c := NewTransferClient(TransferOptions{Idle: 150 * time.Millisecond})
	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	t0 := time.Now()
	_, err = io.ReadAll(resp.Body)
	if !errors.Is(err, ErrStalled) {
		t.Fatalf("want ErrStalled, got %v", err)
	}
	if d := time.Since(t0); d > 3*time.Second {
		t.Fatalf("took %s to notice the stall", d)
	}
}

func TestTransferClientAbortsStalledUpload(t *testing.T) {
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select { // never reads the body
		case <-done:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(done)
	c := NewTransferClient(TransferOptions{Idle: 200 * time.Millisecond})
	body := bytes.NewReader(make([]byte, 256<<20))
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPut, srv.URL, body)
	req.ContentLength = int64(body.Len())
	t0 := time.Now()
	resp, err := c.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatal("stalled upload succeeded")
	}
	if !errors.Is(err, ErrStalled) && !strings.Contains(err.Error(), "stalled") {
		t.Fatalf("want a stall error, got %v", err)
	}
	if d := time.Since(t0); d > 5*time.Second {
		t.Fatalf("took %s to notice the stall", d)
	}
}

func TestTransferClientSlowSteadyUpload(t *testing.T) {
	var got int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4)
		for {
			n, err := r.Body.Read(buf)
			got += n
			if err != nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	defer srv.Close()
	c := NewTransferClient(TransferOptions{Idle: 300 * time.Millisecond})
	body := io.LimitReader(slowZeros{}, 100)
	req, _ := http.NewRequest(http.MethodPut, srv.URL, body)
	req.ContentLength = 100
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got != 100 {
		t.Fatalf("server got %d bytes", got)
	}
}

type slowZeros struct{}

func (slowZeros) Read(p []byte) (int, error) {
	time.Sleep(15 * time.Millisecond)
	if len(p) > 4 {
		p = p[:4]
	}
	return len(p), nil
}
