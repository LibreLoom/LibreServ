package network

import (
	"context"
	"net"
	"time"
)

// DNSResult captures resolution results for a hostname.
type DNSResult struct {
	Hostname    string   `json:"hostname"`
	ARecords    []string `json:"a_records,omitempty"`
	AAAARecords []string `json:"aaaa_records,omitempty"`
	Error       string   `json:"error,omitempty"`
}

// ResolveHostname looks up A/AAAA records with a timeout.
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
