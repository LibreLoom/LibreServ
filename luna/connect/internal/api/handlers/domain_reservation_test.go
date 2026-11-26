package handlers

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

type domainReservationTunnel struct {
	providers.Tunnel

	mu            sync.Mutex
	createCalls   int
	ingressHosts  []string
	deletedTunnel []string

	createStarted chan struct{}
	createRelease chan struct{}
	startOnce     sync.Once
	releaseOnce   sync.Once
}

func (t *domainReservationTunnel) CreateTunnel(accountID, apiToken, name string) (*providers.TunnelCredentials, error) {
	t.mu.Lock()
	t.createCalls++
	first := t.createCalls == 1
	t.mu.Unlock()
	if first && t.createStarted != nil {
		t.startOnce.Do(func() { close(t.createStarted) })
		<-t.createRelease
	}
	return t.Tunnel.CreateTunnel(accountID, apiToken, name)
}

func (t *domainReservationTunnel) ConfigureIngress(accountID, apiToken, tunnelID, hostname, serviceURL string) error {
	t.mu.Lock()
	t.ingressHosts = append(t.ingressHosts, hostname)
	t.mu.Unlock()
	return t.Tunnel.ConfigureIngress(accountID, apiToken, tunnelID, hostname, serviceURL)
}

func (t *domainReservationTunnel) DeleteTunnel(accountID, apiToken, tunnelID string) error {
	t.mu.Lock()
	t.deletedTunnel = append(t.deletedTunnel, tunnelID)
	t.mu.Unlock()
	return t.Tunnel.DeleteTunnel(accountID, apiToken, tunnelID)
}

func (t *domainReservationTunnel) releaseCreate() {
	if t.createRelease != nil {
		t.releaseOnce.Do(func() { close(t.createRelease) })
	}
}

func (t *domainReservationTunnel) counts() (creates int, ingress, deleted []string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.createCalls, append([]string(nil), t.ingressHosts...), append([]string(nil), t.deletedTunnel...)
}

type domainReservationDNS struct {
	providers.DNS

	mu      sync.Mutex
	records map[string]string
	upserts []string
	deletes []string

	blockDeleteHost string
	deleteStarted   chan struct{}
	deleteRelease   chan struct{}
	startOnce       sync.Once
	releaseOnce     sync.Once
}

func newDomainReservationDNS() *domainReservationDNS {
	return &domainReservationDNS{records: make(map[string]string)}
}

func (d *domainReservationDNS) UpsertCNAME(apiToken, zoneID, hostname, target string) error {
	d.mu.Lock()
	d.records[hostname] = target
	d.upserts = append(d.upserts, hostname)
	d.mu.Unlock()
	return nil
}

func (d *domainReservationDNS) DeleteRecord(apiToken, zoneID, hostname string) error {
	d.mu.Lock()
	d.deletes = append(d.deletes, hostname)
	blocked := hostname == d.blockDeleteHost && d.deleteStarted != nil
	d.mu.Unlock()
	if blocked {
		d.startOnce.Do(func() { close(d.deleteStarted) })
		<-d.deleteRelease
	}
	d.mu.Lock()
	delete(d.records, hostname)
	d.mu.Unlock()
	return nil
}

func (d *domainReservationDNS) releaseDelete() {
	if d.deleteRelease != nil {
		d.releaseOnce.Do(func() { close(d.deleteRelease) })
	}
}

func (d *domainReservationDNS) record(hostname string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.records[hostname]
}

func (d *domainReservationDNS) counts() (upserts, deletes []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.upserts...), append([]string(nil), d.deletes...)
}

type domainReservationResult struct {
	out  map[string]any
	code int
	msg  string
}

func provisionDomainAsync(deps Deps, deviceID, subdomain string) <-chan domainReservationResult {
	done := make(chan domainReservationResult, 1)
	go func() {
		out, code, msg := applyDeviceDomain(deps, deviceID, subdomain, 8090)
		done <- domainReservationResult{out: out, code: code, msg: msg}
	}()
	return done
}

func moveDomainAsync(deps Deps, expected Device, subdomain string) <-chan domainReservationResult {
	done := make(chan domainReservationResult, 1)
	go func() {
		out, code, msg := moveDeviceDomain(deps, expected, subdomain)
		done <- domainReservationResult{out: out, code: code, msg: msg}
	}()
	return done
}

func waitDomainResult(t *testing.T, done <-chan domainReservationResult) domainReservationResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("domain operation did not finish")
		return domainReservationResult{}
	}
}

func assertDomainOperationBlocked(t *testing.T, done <-chan domainReservationResult) {
	t.Helper()
	select {
	case result := <-done:
		t.Fatalf("domain operation crossed the hostname fence: code=%d msg=%q", result.code, result.msg)
	case <-time.After(50 * time.Millisecond):
	}
}

func bindDomainReservationDevice(t *testing.T, d Deps, acctH AccountHandler, devH DeviceHandler, email string) (string, string) {
	t.Helper()
	cookie := registerAccount(t, acctH, email)
	verifyEmailFor(t, acctH, email)
	_, uid, code := mintDevice(t, d, "official")
	return pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
}

func assertDomainReservationOwner(t *testing.T, d Deps, subdomain, deviceID string) {
	t.Helper()
	host := domainname.Hostname(subdomain, config.C.Server.PublicZone)
	var owner string
	if err := d.DB.QueryRow(`SELECT device_id FROM domain_reservations WHERE hostname = ?`, host).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != deviceID {
		t.Fatalf("reservation owner = %q, want %q", owner, deviceID)
	}
}

func TestConcurrentSameHostnameProvisioningLosingRollbackPreservesWinnerDNS(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	devA, _ := bindDomainReservationDevice(t, d, acctH, devH, "reserve-a@b.co")
	devB, _ := bindDomainReservationDevice(t, d, acctH, devH, "reserve-b@b.co")

	tunnel := &domainReservationTunnel{
		Tunnel:        d.Tunnel,
		createStarted: make(chan struct{}),
		createRelease: make(chan struct{}),
	}
	dns := newDomainReservationDNS()
	d.Tunnel, d.DNS = tunnel, dns
	t.Cleanup(tunnel.releaseCreate)

	winnerDone := provisionDomainAsync(d, devA, "sharedbox")
	select {
	case <-tunnel.createStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("winner did not reach the tunnel provider")
	}
	loserDone := provisionDomainAsync(d, devB, "sharedbox")
	assertDomainOperationBlocked(t, loserDone)
	creates, _, _ := tunnel.counts()
	if creates != 1 {
		t.Fatalf("loser reached a provider before the winner committed: create calls=%d", creates)
	}

	tunnel.releaseCreate()
	winner := waitDomainResult(t, winnerDone)
	loser := waitDomainResult(t, loserDone)
	if winner.code != http.StatusCreated {
		t.Fatalf("winner code=%d msg=%s", winner.code, winner.msg)
	}
	if loser.code != http.StatusConflict {
		t.Fatalf("loser code=%d msg=%s", loser.code, loser.msg)
	}
	creates, _, _ = tunnel.counts()
	if creates != 1 {
		t.Fatalf("loser wrote to the tunnel provider: create calls=%d", creates)
	}
	host := domainname.Hostname("sharedbox", config.C.Server.PublicZone)
	var tunnelID string
	if err := d.DB.QueryRow(`SELECT tunnel_id FROM devices WHERE id = ?`, devA).Scan(&tunnelID); err != nil {
		t.Fatal(err)
	}
	if got := dns.record(host); got != tunnelID+".cfargotunnel.com" {
		t.Fatalf("winner DNS = %q, want %q", got, tunnelID+".cfargotunnel.com")
	}
	_, deletes := dns.counts()
	if stringContains(deletes, host) {
		t.Fatalf("losing rollback deleted the winner's DNS: %v", deletes)
	}
	assertDomainReservationOwner(t, d, "sharedbox", devA)
}

func TestFirstTimeRollbackDoesNotDeleteDNSOwnedByAnotherDevice(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	devA, _ := bindDomainReservationDevice(t, d, acctH, devH, "rollback-a@b.co")
	devB, _ := bindDomainReservationDevice(t, d, acctH, devH, "rollback-b@b.co")

	tx, err := d.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := database.LockDevice(tx, devB); err != nil {
		t.Fatal(err)
	}
	var accountB string
	if err := tx.QueryRow(`SELECT account_id FROM devices WHERE id = ?`, devB).Scan(&accountB); err != nil {
		t.Fatal(err)
	}
	if err := reserveDeviceDomains(tx, devB, accountB, "rollbackbox"); err != nil {
		t.Fatal(err)
	}

	tunnel := &domainReservationTunnel{Tunnel: d.Tunnel}
	dns := newDomainReservationDNS()
	host := domainname.Hostname("rollbackbox", config.C.Server.PublicZone)
	if err := dns.UpsertCNAME("", "", host, "winner.cfargotunnel.com"); err != nil {
		t.Fatal(err)
	}
	cleanupProvisionedDomain(depsWithProviders(d, tunnel, dns), config.Cloudflare(), tx, devA, host, "operation-tunnel", "", true, true)
	if got := dns.record(host); got != "winner.cfargotunnel.com" {
		t.Fatalf("rollback deleted another device's DNS: %q", got)
	}
	_, deletes := dns.counts()
	if len(deletes) != 0 {
		t.Fatalf("rollback issued DNS deletes after losing ownership: %v", deletes)
	}
	_, _, deletedTunnels := tunnel.counts()
	if len(deletedTunnels) != 1 || deletedTunnels[0] != "operation-tunnel" {
		t.Fatalf("rollback did not limit tunnel cleanup to its own resource: %v", deletedTunnels)
	}
}

func depsWithProviders(d Deps, tunnel providers.Tunnel, dns providers.DNS) Deps {
	d.Tunnel, d.DNS = tunnel, dns
	return d
}

func TestHostnameMoveConflictLeavesBothOwnersDNSIntact(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookieA := registerAccount(t, acctH, "move-a@b.co")
	verifyEmailFor(t, acctH, "move-a@b.co")
	_, uidA, codeA := mintDevice(t, d, "official")
	devA, tokenA := pairDeviceForAccount(t, acctH, devH, cookieA, uidA, codeA)
	devB, _ := bindDomainReservationDevice(t, d, acctH, devH, "move-b@b.co")
	if rec := setAddress(t, acctH, devH, cookieA, devA, "oldbox"); rec.Code != http.StatusCreated {
		t.Fatalf("initial address %d %s", rec.Code, rec.Body.String())
	}
	expectedA, err := loadDeviceByAuthToken(d.DB, tokenA)
	if err != nil {
		t.Fatal(err)
	}
	var oldTunnel string
	if err := d.DB.QueryRow(`SELECT tunnel_id FROM devices WHERE id = ?`, devA).Scan(&oldTunnel); err != nil {
		t.Fatal(err)
	}

	tunnel := &domainReservationTunnel{
		Tunnel:        d.Tunnel,
		createStarted: make(chan struct{}),
		createRelease: make(chan struct{}),
	}
	dns := newDomainReservationDNS()
	oldHost := domainname.Hostname("oldbox", config.C.Server.PublicZone)
	newHost := domainname.Hostname("newbox", config.C.Server.PublicZone)
	if err := dns.UpsertCNAME("", "", oldHost, oldTunnel+".cfargotunnel.com"); err != nil {
		t.Fatal(err)
	}
	d.Tunnel, d.DNS = tunnel, dns
	t.Cleanup(tunnel.releaseCreate)

	winnerDone := provisionDomainAsync(d, devB, "newbox")
	select {
	case <-tunnel.createStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("new owner did not reach the tunnel provider")
	}
	moveDone := moveDomainAsync(d, expectedA, "newbox")
	assertDomainOperationBlocked(t, moveDone)
	tunnel.releaseCreate()
	winner := waitDomainResult(t, winnerDone)
	move := waitDomainResult(t, moveDone)
	if winner.code != http.StatusCreated {
		t.Fatalf("new owner code=%d msg=%s", winner.code, winner.msg)
	}
	if move.code != http.StatusConflict {
		t.Fatalf("conflicting move code=%d msg=%s", move.code, move.msg)
	}
	creates, ingress, _ := tunnel.counts()
	if creates != 1 || len(ingress) != 1 || ingress[0] != newHost {
		t.Fatalf("conflicting move reached a provider: creates=%d ingress=%v", creates, ingress)
	}
	if got := dns.record(oldHost); got != oldTunnel+".cfargotunnel.com" {
		t.Fatalf("old owner's DNS changed: %q", got)
	}
	var newTunnel string
	if err := d.DB.QueryRow(`SELECT tunnel_id FROM devices WHERE id = ?`, devB).Scan(&newTunnel); err != nil {
		t.Fatal(err)
	}
	if got := dns.record(newHost); got != newTunnel+".cfargotunnel.com" {
		t.Fatalf("new owner's DNS changed: %q", got)
	}
	assertDomainReservationOwner(t, d, "oldbox", devA)
	assertDomainReservationOwner(t, d, "newbox", devB)
}

func TestUnbindAndRevokeSerializeHostnameCleanupWithProvisioning(t *testing.T) {
	for _, action := range []string{"unbind", "revoke"} {
		t.Run(action, func(t *testing.T) {
			d := testDeps(t)
			acctH := AccountHandler{Deps: d}
			devH := DeviceHandler{Deps: d}
			cookieA := registerAccount(t, acctH, "cleanup-a-"+action+"@b.co")
			verifyEmailFor(t, acctH, "cleanup-a-"+action+"@b.co")
			_, uidA, codeA := mintDevice(t, d, "official")
			devA, tokenA := pairDeviceForAccount(t, acctH, devH, cookieA, uidA, codeA)
			devB, _ := bindDomainReservationDevice(t, d, acctH, devH, "cleanup-b-"+action+"@b.co")
			if rec := setAddress(t, acctH, devH, cookieA, devA, "cleanupbox"); rec.Code != http.StatusCreated {
				t.Fatalf("initial address %d %s", rec.Code, rec.Body.String())
			}
			expectedA, err := loadDeviceByAuthToken(d.DB, tokenA)
			if err != nil {
				t.Fatal(err)
			}
			var oldTunnel string
			if err := d.DB.QueryRow(`SELECT tunnel_id FROM devices WHERE id = ?`, devA).Scan(&oldTunnel); err != nil {
				t.Fatal(err)
			}

			tunnel := &domainReservationTunnel{Tunnel: d.Tunnel}
			dns := newDomainReservationDNS()
			host := domainname.Hostname("cleanupbox", config.C.Server.PublicZone)
			if err := dns.UpsertCNAME("", "", host, oldTunnel+".cfargotunnel.com"); err != nil {
				t.Fatal(err)
			}
			dns.blockDeleteHost = host
			dns.deleteStarted = make(chan struct{})
			dns.deleteRelease = make(chan struct{})
			d.Tunnel, d.DNS = tunnel, dns
			t.Cleanup(dns.releaseDelete)

			cleanupDone := make(chan error, 1)
			go func() {
				if action == "revoke" {
					cleanupDone <- revokeDevice(d, expectedA, expectedA.AccountID.String)
					return
				}
				cleanupDone <- unbindDevice(d, expectedA, expectedA.AccountID.String)
			}()
			select {
			case <-dns.deleteStarted:
			case <-time.After(3 * time.Second):
				t.Fatal("cleanup did not reach DNS teardown")
			}

			provisionDone := provisionDomainAsync(d, devB, "cleanupbox")
			assertDomainOperationBlocked(t, provisionDone)
			creates, _, _ := tunnel.counts()
			if creates != 0 {
				t.Fatalf("new owner reached the provider before cleanup committed: creates=%d", creates)
			}
			dns.releaseDelete()
			select {
			case err := <-cleanupDone:
				if err != nil {
					t.Fatalf("%s: %v", action, err)
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("%s did not finish", action)
			}
			provision := waitDomainResult(t, provisionDone)
			if provision.code != http.StatusCreated {
				t.Fatalf("replacement provisioning code=%d msg=%s", provision.code, provision.msg)
			}
			var newTunnel string
			if err := d.DB.QueryRow(`SELECT tunnel_id FROM devices WHERE id = ?`, devB).Scan(&newTunnel); err != nil {
				t.Fatal(err)
			}
			if got := dns.record(host); got != newTunnel+".cfargotunnel.com" {
				t.Fatalf("cleanup deleted the new owner's DNS: %q", got)
			}
			_, deletes := dns.counts()
			if len(deletes) != 1 || deletes[0] != host {
				t.Fatalf("cleanup DNS deletes = %v, want only the old owner's record", deletes)
			}
			assertDomainReservationOwner(t, d, "cleanupbox", devB)
		})
	}
}

func TestDomainReservationSchemaIsMigrated(t *testing.T) {
	d := testDeps(t)
	var count int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'domain_reservations'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("domain_reservations table count = %d", count)
	}
	if _, err := d.DB.Exec(`SELECT hostname FROM domain_reservations LIMIT 1`); err != nil {
		t.Fatalf("domain reservation schema is not usable: %v", err)
	}
}
