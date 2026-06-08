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

type bleClient struct {
	setupCode string
	logger    *slog.Logger

	adapter  *bluetooth.Adapter
	device   bluetooth.Device
	authChar bluetooth.DeviceCharacteristic
	authStatusChar bluetooth.DeviceCharacteristic
	proxyReqChar   bluetooth.DeviceCharacteristic
	proxyRespChar  bluetooth.DeviceCharacteristic

	mu        sync.Mutex
	connected bool
	authed    bool
	pending   map[string]chan *proxyResponse
}

func newBLEClient(setupCode string, logger *slog.Logger) *bleClient {
	return &bleClient{
		setupCode: setupCode,
		logger:    logger,
		pending:   make(map[string]chan *proxyResponse),
	}
}

func (c *bleClient) connect() error {
	c.adapter = bluetooth.DefaultAdapter

	if err := c.adapter.Enable(); err != nil {
		return fmt.Errorf("bluetooth enable: %w", err)
	}

	c.logger.Info("Scanning for LibreServ device...")

	found := make(chan bluetooth.ScanResult, 1)

	go func() {
		time.Sleep(30 * time.Second)
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
		return fmt.Errorf("scan failed: %w", err)
	}

	var target bluetooth.ScanResult
	select {
	case target = <-found:
		// discovered
	case <-time.After(30 * time.Second):
		return errors.New("no LibreServ device found within 30 seconds")
	}

	if err := c.adapter.StopScan(); err != nil {
		c.logger.Warn("failed to stop scan", "error", err)
	}

	c.logger.Info("Found LibreServ", "name", target.LocalName(), "address", target.Address.String())

	device, err := c.adapter.Connect(target.Address, bluetooth.ConnectionParams{})
	if err != nil {
		return fmt.Errorf("connect failed: %w", err)
	}

	c.device = device
	c.logger.Info("Connected to LibreServ")

	services, err := device.DiscoverServices([]bluetooth.UUID{serviceUUID})
	if err != nil {
		return fmt.Errorf("discover services: %w", err)
	}
	if len(services) == 0 {
		return errors.New("service not found on device")
	}

	chars, err := services[0].DiscoverCharacteristics([]bluetooth.UUID{
		charAuth,
		charAuthStatus,
		charProxyReq,
		charProxyResp,
	})
	if err != nil {
		return fmt.Errorf("discover characteristics: %w", err)
	}

	for _, ch := range chars {
		switch ch.UUID() {
		case charAuth:
			c.authChar = ch
		case charAuthStatus:
			c.authStatusChar = ch
		case charProxyReq:
			c.proxyReqChar = ch
		case charProxyResp:
			c.proxyRespChar = ch
		}
	}

	if err := c.authStatusChar.EnableNotifications(c.onAuthStatus); err != nil {
		return fmt.Errorf("auth status notify: %w", err)
	}
	if err := c.proxyRespChar.EnableNotifications(c.onProxyResponse); err != nil {
		return fmt.Errorf("proxy resp notify: %w", err)
	}

	if err := c.authenticate(); err != nil {
		return fmt.Errorf("authentication: %w", err)
	}

	c.connected = true
	return nil
}

func (c *bleClient) onAuthStatus(buf []byte) {
	var s authStatus
	if err := json.Unmarshal(buf, &s); err != nil {
		c.logger.Warn("malformed auth status", "error", err)
		return
	}
	c.mu.Lock()
	if s.OK {
		c.authed = true
		c.logger.Info("BLE authentication succeeded")
	} else {
		c.authed = false
		c.logger.Warn("BLE authentication failed", "message", s.Message)
	}
	c.mu.Unlock()
}

func (c *bleClient) onProxyResponse(buf []byte) {
	var pr proxyResponse
	if err := json.Unmarshal(buf, &pr); err != nil {
		c.logger.Warn("malformed proxy response", "error", err)
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

	if c.proxyReqChar == nil {
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
	return c.device.Disconnect()
}
