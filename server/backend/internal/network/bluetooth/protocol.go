package bluetooth

// proxyRequest is a single HTTP request sent by the companion app.
type proxyRequest struct {
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Chunk   int               `json:"chunk"`
	Final   bool              `json:"final"`
}

// proxyResponse is a single HTTP response sent back to the companion app.
type proxyResponse struct {
	ID         string            `json:"id"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	Chunk      int               `json:"chunk"`
	Final      bool              `json:"final"`
}

// authStatus is notified on the Auth Status characteristic.
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
