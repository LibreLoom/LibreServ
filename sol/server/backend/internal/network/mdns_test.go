package network

import (
	"net"
	"testing"

	"github.com/hashicorp/mdns"
	"github.com/miekg/dns"
)

func TestLibreservZoneRespondsToLibreservLocal(t *testing.T) {
	svc, err := mdns.NewMDNSService("LibreServ", "_http._tcp", "local.", "", 8080, []net.IP{net.ParseIP("192.168.1.3")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	zone := &libreservZone{MDNSService: svc, ips: []net.IP{net.ParseIP("192.168.1.3")}}

	rr := zone.Records(dns.Question{
		Name:  "libreserv.local.",
		Qtype: dns.TypeA,
	})

	if len(rr) == 0 {
		t.Fatal("expected A records for libreserv.local., got none")
	}

	a, ok := rr[0].(*dns.A)
	if !ok {
		t.Fatalf("expected *dns.A, got %T", rr[0])
	}
	if a.A.String() != "192.168.1.3" {
		t.Fatalf("expected IP 192.168.1.3, got %s", a.A)
	}
}

func TestLibreservZoneStillServesServiceRecords(t *testing.T) {
	svc, err := mdns.NewMDNSService("LibreServ", "_http._tcp", "local.", "", 8080, []net.IP{net.ParseIP("192.168.1.3")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	zone := &libreservZone{MDNSService: svc, ips: []net.IP{net.ParseIP("192.168.1.3")}}

	rr := zone.Records(dns.Question{
		Name:  "_http._tcp.local.",
		Qtype: dns.TypePTR,
	})

	if len(rr) == 0 {
		t.Fatal("expected PTR records for _http._tcp.local., got none")
	}
}

func TestLibreservZoneIgnoresUnrelatedQueries(t *testing.T) {
	svc, err := mdns.NewMDNSService("LibreServ", "_http._tcp", "local.", "", 8080, []net.IP{net.ParseIP("192.168.1.3")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	zone := &libreservZone{MDNSService: svc, ips: []net.IP{net.ParseIP("192.168.1.3")}}

	rr := zone.Records(dns.Question{
		Name:  "some-other-device.local.",
		Qtype: dns.TypeA,
	})

	if len(rr) != 0 {
		t.Fatalf("expected no records for unrelated query, got %d", len(rr))
	}
}
