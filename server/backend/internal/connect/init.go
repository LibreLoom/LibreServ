package connect

import "os"

func NewClientFromEnv() Client {
	token := os.Getenv("LIBRESERV_CONNECT_TOKEN")

	if os.Getenv("LIBRESERV_CONNECT_FAKE") == "true" {
		fake := NewFakeClient()
		if token != "" {
			fake.Activate(nil, token)
		}
		return fake
	}

	return NewRealClient(Config{
		Token:   token,
		BaseURL: os.Getenv("LIBRESERV_CONNECT_API_URL"),
	})
}
