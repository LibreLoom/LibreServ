package connect

import (
	"context"
	"os"

	"gt.plainskill.net/LibreLoom/Sol/internal/config"
)

func NewClientFromEnv() Client {
	key := os.Getenv("SOL_CONNECT_KEY")
	baseURL := os.Getenv("SOL_CONNECT_API_URL")

	if cfg := config.Get(); cfg != nil {
		if key == "" {
			key = cfg.Connect.Token
		}
		if baseURL == "" {
			baseURL = cfg.Connect.APIURL
		}
	}

	if os.Getenv("SOL_CONNECT_FAKE") == "true" {
		fake := NewFakeClient()
		if key != "" {
			fake.Activate(context.Background(), key)
		}
		return fake
	}

	return NewRealClient(Config{
		ConnectKey: key,
		BaseURL:    baseURL,
	})
}
