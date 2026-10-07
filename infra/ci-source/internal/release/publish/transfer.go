package publish

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

// TransferOptions tune NewTransferClient. Zero values mean the defaults.
type TransferOptions struct {
	Dial           time.Duration // connect, default 30s
	TLSHandshake   time.Duration // default 30s
	ResponseHeader time.Duration // from the end of the request to the first response byte, default 10m (the registry may assemble a multi-GB upload first)
	Idle           time.Duration // longest pause without a byte moving, default 60s
}

// ErrStalled is wrapped by errors from a transfer that stopped moving.
var ErrStalled = errors.New("transfer stalled")

// NewTransferClient is the client for multi-GB uploads and downloads. It has
// no whole-request timeout (a slow but steady transfer may take as long as it
// needs); instead a connection that makes no progress for Idle is aborted.
func NewTransferClient(o TransferOptions) *http.Client {
	if o.Dial == 0 {
		o.Dial = 30 * time.Second
	}
	if o.TLSHandshake == 0 {
		o.TLSHandshake = 30 * time.Second
	}
	if o.ResponseHeader == 0 {
		o.ResponseHeader = 10 * time.Minute
	}
	if o.Idle == 0 {
		o.Idle = 60 * time.Second
	}
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.DialContext = (&net.Dialer{Timeout: o.Dial, KeepAlive: 30 * time.Second}).DialContext
	base.TLSHandshakeTimeout = o.TLSHandshake
	base.ResponseHeaderTimeout = o.ResponseHeader
	return &http.Client{Transport: &idleTransport{base: base, idle: o.Idle}}
}

// idleTransport aborts a request when neither its body nor its response body
// moves for idle. The clock runs while the request body is being sent and
// while the response body is being read; the wait in between is bounded by
// ResponseHeaderTimeout.
type idleTransport struct {
	base http.RoundTripper
	idle time.Duration
}

type watchdog struct {
	mu      sync.Mutex
	timer   *time.Timer
	idle    time.Duration
	cancel  context.CancelFunc
	stalled bool
}

func (w *watchdog) fire() {
	w.mu.Lock()
	w.stalled = true
	w.mu.Unlock()
	w.cancel()
}

func (w *watchdog) kick() {
	w.mu.Lock()
	if !w.stalled {
		w.timer.Reset(w.idle)
	}
	w.mu.Unlock()
}

func (w *watchdog) stop() {
	w.mu.Lock()
	w.timer.Stop()
	w.mu.Unlock()
}

func (w *watchdog) err(err error) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stalled && err != nil && err != io.EOF {
		return fmt.Errorf("%w: no data for %s", ErrStalled, w.idle)
	}
	return err
}

func (t *idleTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithCancel(req.Context())
	w := &watchdog{idle: t.idle, cancel: cancel}
	w.timer = time.AfterFunc(t.idle, w.fire)
	r2 := req.Clone(ctx)
	if req.Body != nil && req.Body != http.NoBody {
		r2.Body = &idleBody{rc: req.Body, w: w, eofStops: true}
	} else {
		w.stop() // nothing to send; the header timeout covers the wait
	}
	resp, err := t.base.RoundTrip(r2)
	if err != nil {
		w.stop()
		cancel()
		return nil, w.err(err)
	}
	w.kick()
	resp.Body = &idleBody{rc: resp.Body, w: w, closeCancels: true}
	return resp, nil
}

type idleBody struct {
	rc           io.ReadCloser
	w            *watchdog
	eofStops     bool // request body: the clock stops once it is fully sent
	closeCancels bool // response body: closing releases the request context
}

func (b *idleBody) Read(p []byte) (int, error) {
	n, err := b.rc.Read(p)
	if err == io.EOF && b.eofStops {
		b.w.stop()
	} else if n > 0 {
		b.w.kick()
	}
	return n, b.w.err(err)
}

func (b *idleBody) Close() error {
	err := b.rc.Close()
	if b.closeCancels {
		b.w.stop()
		b.w.cancel()
	}
	return err
}
