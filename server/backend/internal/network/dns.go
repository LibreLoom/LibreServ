package network

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/libdns/libdns"
)

var publicIPClient = &http.Client{Timeout: 10 * time.Second}

type ProviderType string

const (
	ProviderCloudflare ProviderType = "cloudflare"
)

type DNSProviderConfig struct {
	ID        string       `json:"id"`
	Provider  ProviderType `json:"provider"`
	Domain    string       `json:"domain"`
	APIToken  string       `json:"-"`
	Enabled   bool         `json:"enabled"`
	CreatedAt time.Time    `json:"created_at"`
	UpdatedAt time.Time    `json:"updated_at"`
}

func (c *DNSProviderConfig) Zone() string {
	d := c.Domain
	if d == "" {
		return ""
	}
	if d[len(d)-1] != '.' {
		d += "."
	}
	return d
}

type DNSProvider interface {
	Validate(ctx context.Context, zone string) error
	Records() libdns.RecordSetter
}

func SetARecord(ctx context.Context, s libdns.RecordSetter, zone, name string, ip netip.Addr, ttl time.Duration) error {
	_, err := s.SetRecords(ctx, zone, []libdns.Record{
		libdns.Address{
			Name: name,
			TTL:  ttl,
			IP:   ip,
		},
	})
	if err != nil {
		return fmt.Errorf("set A record %q in zone %q: %w", name, zone, err)
	}
	return nil
}

func SetAAAARecord(ctx context.Context, s libdns.RecordSetter, zone, name string, ip netip.Addr, ttl time.Duration) error {
	_, err := s.SetRecords(ctx, zone, []libdns.Record{
		libdns.Address{
			Name: name,
			TTL:  ttl,
			IP:   ip,
		},
	})
	if err != nil {
		return fmt.Errorf("set AAAA record %q in zone %q: %w", name, zone, err)
	}
	return nil
}

func SetTXTRecord(ctx context.Context, s libdns.RecordSetter, zone, name, value string, ttl time.Duration) error {
	_, err := s.SetRecords(ctx, zone, []libdns.Record{
		libdns.TXT{
			Name: name,
			TTL:  ttl,
			Text: value,
		},
	})
	if err != nil {
		return fmt.Errorf("set TXT record %q in zone %q: %w", name, zone, err)
	}
	return nil
}

type DNSResult struct {
	Hostname    string   `json:"hostname"`
	ARecords    []string `json:"a_records,omitempty"`
	AAAARecords []string `json:"aaaa_records,omitempty"`
	Error       string   `json:"error,omitempty"`
}

func DetectPublicIP(ctx context.Context) (netip.Addr, error) {
	services := []string{
		"https://api64.ipify.org",
		"https://icanhazip.com",
	}
	for _, url := range services {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "LibreServ/1.0")
		resp, err := publicIPClient.Do(req)
		if err != nil {
			continue
		}
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK {
			continue
		}
		ipStr := strings.TrimSpace(string(body))
		addr, err := netip.ParseAddr(ipStr)
		if err != nil {
			continue
		}
		return addr, nil
	}
	return netip.Addr{}, fmt.Errorf("failed to detect public IP from any service")
}

func ResolveHostname(ctx context.Context, host string, timeout time.Duration) (*DNSResult, error) {
	res := &DNSResult{Hostname: host}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type outcome struct {
		ips []net.IP
		err error
	}

	chA := make(chan outcome, 1)
	chAAAA := make(chan outcome, 1)

	go func() {
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", host)
		chA <- outcome{ips: ips, err: err}
	}()
	go func() {
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip6", host)
		chAAAA <- outcome{ips: ips, err: err}
	}()

	aRes := <-chA
	aaaaRes := <-chAAAA

	for _, ip := range aRes.ips {
		res.ARecords = append(res.ARecords, ip.String())
	}
	for _, ip := range aaaaRes.ips {
		res.AAAARecords = append(res.AAAARecords, ip.String())
	}
	if aRes.err != nil && aaaaRes.err != nil {
		res.Error = aRes.err.Error()
		if aaaaRes.err != nil {
			res.Error = res.Error + "; " + aaaaRes.err.Error()
		}
	}
	return res, nil
}
