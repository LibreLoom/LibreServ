package network

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

// legoProviderConfig maps a DNSProviderConfig to lego's DNS provider name and required environment variables.
func legoProviderConfig(cfg *DNSProviderConfig) (provider string, env map[string]string, err error) {
	switch cfg.Provider {
	case ProviderCloudflare:
		return "cloudflare", map[string]string{"CLOUDFLARE_DNS_API_TOKEN": cfg.APIToken}, nil
	default:
		return "", nil, fmt.Errorf("unsupported provider for lego: %s", cfg.Provider)
	}
}
