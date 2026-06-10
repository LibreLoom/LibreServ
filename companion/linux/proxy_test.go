package main

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
)

func accumulateResponse(queue <-chan *proxyResponse) (*proxyResponse, error) {
	var chunks [][]byte
	var status int
	var headers map[string]string
	for pr := range queue {
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
			return &proxyResponse{Status: status, Headers: headers, Body: base64.StdEncoding.EncodeToString(fullBody)}, nil
		}
	}
	return nil, context.DeadlineExceeded
}

func TestAccumulateResponse_SingleChunk(t *testing.T) {
	ch := make(chan *proxyResponse, 1)
	ch <- &proxyResponse{
		Status:  200,
		Headers: map[string]string{"Content-Type": "text/html"},
		Body:    base64.StdEncoding.EncodeToString([]byte("hello")),
		Chunk:   0,
		Final:   true,
	}
	close(ch)

	resp, err := accumulateResponse(ch)
	if err != nil {
		t.Fatalf("accumulate error: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	body, _ := base64.StdEncoding.DecodeString(resp.Body)
	if string(body) != "hello" {
		t.Fatalf("unexpected body: %s", string(body))
	}
}

func TestAccumulateResponse_MultiChunk(t *testing.T) {
	ch := make(chan *proxyResponse, 3)
	ch <- &proxyResponse{
		Status:  200,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    base64.StdEncoding.EncodeToString([]byte("Hel")),
		Chunk:   0,
		Final:   false,
	}
	ch <- &proxyResponse{
		Body:  base64.StdEncoding.EncodeToString([]byte("lo ")),
		Chunk: 1,
		Final: false,
	}
	ch <- &proxyResponse{
		Body:  base64.StdEncoding.EncodeToString([]byte("World")),
		Chunk: 2,
		Final: true,
	}
	close(ch)

	resp, err := accumulateResponse(ch)
	if err != nil {
		t.Fatalf("accumulate error: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	body, _ := base64.StdEncoding.DecodeString(resp.Body)
	if string(body) != "Hello World" {
		t.Fatalf("unexpected body: %s", string(body))
	}
}

func TestAccumulateResponse_Timeout(t *testing.T) {
	ch := make(chan *proxyResponse)
	close(ch) // no final chunk

	_, err := accumulateResponse(ch)
	if err == nil {
		t.Fatal("expected error when channel closes without final chunk")
	}
}

func TestDoRequest_NotAvailable(t *testing.T) {
	c := newBLEClient()
	ctx := context.Background()
	req := proxyRequest{ID: "req-1", Method: "GET", Path: "/", Final: true}
	_, err := c.doRequest(ctx, req)
	if err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("expected 'not available' error, got: %v", err)
	}
}
