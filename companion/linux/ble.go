package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"tinygo.org/x/bluetooth"
)

var requestCounter uint64

func generateID() string {
	return fmt.Sprintf("req-%d", atomic.AddUint64(&requestCounter, 1))
}

type connectStatus int

const (
	statusScanning  connectStatus = iota
	statusFound                   // msg = device name
	statusConnected               // BLE connected
	statusAuthed                  // Authenticated, proxy started
	statusFailed                  // msg = error text
	statusLost                    // msg = error text
)

// bleClient manages the BLE connection, authentication, and HTTP proxying.
type bleClient struct {
	mu        sync.Mutex
	setupCode string
	connected bool
	authed    bool
	pending   map[string]chan *proxyResponse

	adapter        *bluetooth.Adapter
	device         bluetooth.Device
	authChar       *bluetooth.DeviceCharacteristic
	authStatusChar *bluetooth.DeviceCharacteristic
	proxyReqChar   *bluetooth.DeviceCharacteristic
	proxyRespChar  *bluetooth.DeviceCharacteristic

	proxy  *proxyServer
	lostCh chan struct{} // signaled when connection is lost
}

func newBLEClient() *bleClient {
	return &bleClient{
		pending: make(map[string]chan *proxyResponse),
		lostCh:  make(chan struct{}, 1),
	}
}

// connect scans for a LibreServ device, authenticates, and starts the proxy.
// It calls onStatus from a background goroutine to report progress.
// It blocks until the connection either succeeds (statusAuthed) or fails (statusFailed).
func (c *bleClient) connect(setupCode string, onStatus func(connectStatus, string)) {
	c.mu.Lock()
	c.setupCode = setupCode
	c.connected = false
	c.authed = false
	c.mu.Unlock()

	onStatus(statusScanning, "")

	c.adapter = bluetooth.DefaultAdapter
	if err := c.adapter.Enable(); err != nil {
		onStatus(statusFailed, fmt.Sprintf("Could not enable Bluetooth. Make sure Bluetooth is turned on in your system settings. (%v)", err))
		return
	}

	// Scan for the LibreServ device
	found := make(chan bluetooth.ScanResult, 1)
	scanTimeout := 30 * time.Second

	go func() {
		time.Sleep(scanTimeout)
		_ = c.adapter.StopScan()
	}()

	err := c.adapter.Scan(func(adapter *bluetooth.Adapter, result bluetooth.ScanResult) {
		for _, u := range result.ServiceUUIDs() {
			if u == serviceUUID {
				found <- result
				_ = adapter.StopScan()
				return
			}
		}
	})

	if err != nil {
		onStatus(statusFailed, fmt.Sprintf("Could not scan for devices. Make sure Bluetooth is turned on. (%v)", err))
		return
	}

	var target bluetooth.ScanResult
	select {
	case target = <-found:
		// found
	case <-time.After(scanTimeout):
		onStatus(statusFailed, "No LibreServ device found nearby. Make sure your device is powered on and within Bluetooth range (about 10 meters).")
		return
	}

	_ = c.adapter.StopScan()
	name := target.LocalName()
	if name == "" {
		name = "LibreServ"
	}
	onStatus(statusFound, name)

	// Connect
	device, err := c.adapter.Connect(target.Address, bluetooth.ConnectionParams{})
	if err != nil {
		onStatus(statusFailed, fmt.Sprintf("Could not connect to %s. Try moving closer to the device and try again.", name))
		return
	}

	c.device = device
	c.mu.Lock()
	c.connected = true
	c.mu.Unlock()
	onStatus(statusConnected, name)

	// Discover services + characteristics
	services, err := device.DiscoverServices([]bluetooth.UUID{serviceUUID})
	if err != nil {
		onStatus(statusFailed, "Could not discover services on the device. Try restarting your device and try again.")
		c.disconnect()
		return
	}
	if len(services) == 0 {
		onStatus(statusFailed, "The LibreServ Bluetooth service was not found on the device. Make sure your device is running a compatible version.")
		c.disconnect()
		return
	}

	chars, err := services[0].DiscoverCharacteristics([]bluetooth.UUID{
		charAuth,
		charAuthStatus,
		charProxyReq,
		charProxyResp,
	})
	if err != nil {
		onStatus(statusFailed, "Could not set up the Bluetooth connection. Try again.")
		c.disconnect()
		return
	}

	for i := range chars {
		switch chars[i].UUID() {
		case charAuth:
			c.authChar = &chars[i]
		case charAuthStatus:
			c.authStatusChar = &chars[i]
		case charProxyReq:
			c.proxyReqChar = &chars[i]
		case charProxyResp:
			c.proxyRespChar = &chars[i]
		}
	}

	// Enable notifications
	if err := c.authStatusChar.EnableNotifications(c.onAuthStatus); err != nil {
		onStatus(statusFailed, "Could not set up Bluetooth notifications. Try again.")
		c.disconnect()
		return
	}
	if err := c.proxyRespChar.EnableNotifications(c.onProxyResponse); err != nil {
		onStatus(statusFailed, "Could not set up Bluetooth notifications. Try again.")
		c.disconnect()
		return
	}

	// Authenticate
	if err := c.authenticate(); err != nil {
		onStatus(statusFailed, "Authentication failed. Check that the code matches the one printed on your device.")
		c.disconnect()
		return
	}

	onStatus(statusAuthed, name)
}

func (c *bleClient) onAuthStatus(buf []byte) {
	var s authStatus
	if err := json.Unmarshal(buf, &s); err != nil {
		return
	}
	c.mu.Lock()
	c.authed = s.OK
	c.mu.Unlock()
}

func (c *bleClient) onProxyResponse(buf []byte) {
	var pr proxyResponse
	if err := json.Unmarshal(buf, &pr); err != nil {
		return
	}
	c.mu.Lock()
	ch, ok := c.pending[pr.ID]
	c.mu.Unlock()
	if ok {
		select {
		case ch <- &pr:
		default:
		}
	}
}

func (c *bleClient) authenticate() error {
	c.mu.Lock()
	c.authed = false
	c.mu.Unlock()

	if _, err := c.authChar.WriteWithoutResponse([]byte(c.setupCode)); err != nil {
		return fmt.Errorf("write auth code: %w", err)
	}

	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		c.mu.Lock()
		ok := c.authed
		c.mu.Unlock()
		if ok {
			return nil
		}
	}
	return errors.New("authentication timed out after 5 seconds")
}

// startProxy starts the local HTTP proxy and returns the listen address.
func (c *bleClient) startProxy() string {
	c.proxy = newProxyServer("127.0.0.1:18080", c)
	go func() {
		if err := c.proxy.Start(); err != nil {
			slog.Error("proxy server failed", "error", err)
		}
	}()
	return "127.0.0.1:18080"
}

// doRequest sends an HTTP request through BLE and returns the response.
func (c *bleClient) doRequest(ctx context.Context, req proxyRequest) (*proxyResponse, error) {
	ch := make(chan *proxyResponse, 16)
	c.mu.Lock()
	c.pending[req.ID] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, req.ID)
		c.mu.Unlock()
	}()

	if c.proxyReqChar == nil || *c.proxyReqChar == (bluetooth.DeviceCharacteristic{}) {
		return nil, errors.New("BLE proxy request characteristic not available")
	}

	j, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	if _, err := c.proxyReqChar.WriteWithoutResponse(j); err != nil {
		return nil, fmt.Errorf("BLE write failed: %w", err)
	}

	var chunks [][]byte
	var status int
	var headers map[string]string

	for {
		select {
		case pr := <-ch:
			if pr.Chunk == 0 {
				status = pr.Status
				headers = pr.Headers
			}
			body, _ := base64.StdEncoding.DecodeString(pr.Body)
			chunks = append(chunks, body)
			if pr.Final {
				var fullBody []byte
				for _, b := range chunks {
					fullBody = append(fullBody, b...)
				}
				return &proxyResponse{
					Status:  status,
					Headers: headers,
					Body:    base64.StdEncoding.EncodeToString(fullBody),
				}, nil
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (c *bleClient) disconnect() error {
	c.mu.Lock()
	c.connected = false
	c.authed = false
	c.mu.Unlock()

	// Signal connection loss
	select {
	case c.lostCh <- struct{}{}:
	default:
	}

	if c.device.Address.String() != "" {
		return c.device.Disconnect()
	}
	return nil
}
