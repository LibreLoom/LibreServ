package connect

import (
	"context"
	"os"
)

func NewClientFromEnv() Client {
	key := os.Getenv("LIBRESERV_CONNECT_KEY")

	if os.Getenv("LIBRESERV_CONNECT_FAKE") == "true" {
		fake := NewFakeClient()
		if key != "" {
			fake.Activate(context.TODO(), key)
		}
		return fake
	}

	return NewRealClient(Config{
		ConnectKey: key,
		BaseURL:    os.Getenv("LIBRESERV_CONNECT_API_URL"),
	})
}
