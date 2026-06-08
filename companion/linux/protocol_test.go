package main

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestChunkBytes(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		size int
		want int
	}{
		{"empty", []byte{}, 10, 1},
		{"exact", []byte("1234567890"), 10, 1},
		{"split", []byte("1234567890"), 4, 3},
		{"single-char", []byte("x"), 10, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := chunkBytes(tt.data, tt.size)
			if len(got) != tt.want {
				t.Fatalf("chunkBytes(%q, %d) returned %d chunks, want %d", tt.data, tt.size, len(got), tt.want)
			}
			joined := []byte{}
			for _, c := range got {
				joined = append(joined, c...)
			}
			if string(joined) != string(tt.data) {
				t.Fatalf("reconstructed %q, want %q", joined, tt.data)
			}
		})
	}
}

func TestProxyRequestRoundTrip(t *testing.T) {
	req := proxyRequest{
		ID:      "abc-123",
		Method:  "POST",
		Path:    "/api/v1/test",
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    base64.StdEncoding.EncodeToString([]byte("hello")),
		Chunk:   0,
		Final:   true,
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var decoded proxyRequest
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ID != req.ID || decoded.Method != req.Method || decoded.Path != req.Path || decoded.Body != req.Body || !decoded.Final {
		t.Fatalf("round-trip mismatch: %+v", decoded)
	}
}

func TestProxyResponseRoundTrip(t *testing.T) {
	resp := proxyResponse{
		ID:     "abc-123",
		Status: 200,
		Body:   base64.StdEncoding.EncodeToString([]byte("hello")),
		Chunk:  0,
		Final:  true,
	}
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var decoded proxyResponse
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ID != resp.ID || decoded.Status != resp.Status || decoded.Body != resp.Body || !decoded.Final {
		t.Fatalf("round-trip mismatch: %+v", decoded)
	}
}
