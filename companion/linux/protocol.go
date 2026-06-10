package main

import "tinygo.org/x/bluetooth"

func mustParseUUID(s string) bluetooth.UUID {
	u, err := bluetooth.ParseUUID(s)
	if err != nil {
		panic(err)
	}
	return u
}

var (
	serviceUUID    = mustParseUUID("5a494c42-6572-6572-7600-000000000000")
	charAuth       = mustParseUUID("5a494c42-6572-6572-7600-000000000002")
	charAuthStatus = mustParseUUID("5a494c42-6572-6572-7600-000000000003")
	charProxyReq   = mustParseUUID("5a494c42-6572-6572-7600-000000000004")
	charProxyResp  = mustParseUUID("5a494c42-6572-6572-7600-000000000005")
)

// proxyRequest is a single HTTP request sent to the LibreServ server.
type proxyRequest struct {
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Chunk   int               `json:"chunk"`
	Final   bool              `json:"final"`
}

// proxyResponse is a single HTTP response received from the LibreServ server.
type proxyResponse struct {
	ID         string            `json:"id"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	Chunk      int               `json:"chunk"`
	Final      bool              `json:"final"`
}

// authStatus is received on the Auth Status characteristic.
type authStatus struct {
	OK        bool   `json:"ok"`
	Message   string `json:"message,omitempty"`
	Timestamp int64  `json:"ts"`
}

func chunkBytes(data []byte, size int) [][]byte {
	if len(data) == 0 {
		return [][]byte{{}}
	}
	var out [][]byte
	for i := 0; i < len(data); i += size {
		j := i + size
		if j > len(data) {
			j = len(data)
		}
		out = append(out, data[i:j])
	}
	return out
}
