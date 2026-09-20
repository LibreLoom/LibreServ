package network

import (
	"net"
	"testing"
)

func TestIsBlockedIP(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		want bool
	}{
		{"loopback v4", "127.0.0.1", true},
		{"loopback v6", "::1", true},
		{"private 10.x", "10.0.0.1", true},
		{"private 172.16.x", "172.16.0.1", true},
		{"private 192.168.x", "192.168.1.1", true},
		{"link-local v4", "169.254.1.1", true},
		{"link-local v6", "fe80::1", true},
		{"unspecified v4", "0.0.0.0", true},
		{"unspecified v6", "::", true},
		{"link-local multicast", "224.0.0.1", true},
		{"public v4", "8.8.8.8", false},
		{"public v6", "2001:4860:4860::8888", false},
		{"cgnat lower bound", "100.64.0.0", true},
		{"cgnat alibaba metadata", "100.100.100.200", true},
		{"cgnat upper bound", "100.127.255.255", true},
		{"just below cgnat", "100.63.255.255", false},
		{"just above cgnat", "100.128.0.0", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip := net.ParseIP(tt.ip)
			if ip == nil {
				t.Fatalf("failed to parse IP %s", tt.ip)
			}
			if got := IsBlockedIP(ip); got != tt.want {
				t.Errorf("IsBlockedIP(%s) = %v, want %v", tt.ip, got, tt.want)
			}
		})
	}
}

func TestValidateHost(t *testing.T) {
	tests := []struct {
		name    string
		host    string
		wantErr bool
	}{
		{"public ip", "8.8.8.8", false},
		{"public hostname", "example.com", false},
		{"loopback ip", "127.0.0.1", true},
		{"private ip", "10.0.0.1", true},
		{"unspecified ip", "0.0.0.0", true},
		{"unspecified v6", "::", true},
		{"gcp metadata", "metadata.google.internal", true},
		{"azure metadata", "metadata.azure.internal", true},
		{"metadata substring safe", "my-metadata-service.example.com", false},
		{"alibaba metadata host", "alibaba.zjgmeta.internal", true},
		{"alibaba metadata ip string", "100.100.100.200", true},
		{"aws ipv6 metadata", "fd00:ec2::254", true},
		{"link-local", "169.254.169.254", true},
		{"empty string", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateHost(tt.host)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateHost(%q) error = %v, wantErr %v", tt.host, err, tt.wantErr)
			}
		})
	}
}
