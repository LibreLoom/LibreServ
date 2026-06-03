package connect

import (
	"context"
	"os"
)

func NewClientFromEnv() Client {
	token := os.Getenv("LIBRESERV_CONNECT_TOKEN")

	if os.Getenv("LIBRESERV_CONNECT_FAKE") == "true" {
		fake := NewFakeClient()
		if token != "" {
			fake.Activate(context.TODO(), token)
		}
		return fake
	}

	return NewRealClient(Config{
		Token:   token,
		BaseURL: os.Getenv("LIBRESERV_CONNECT_API_URL"),
	})
}
