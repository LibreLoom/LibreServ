package handlers

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/domainname"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type boundDeviceDomain struct {
	ID            string
	AccountID     string
	Subdomain     string
	TunnelID      string
	Sealed        string
	Port          int
	State         string
	AuthTokenHash string
}

var errDomainFence = errors.New("device domain changed")

func loadBoundDeviceDomainTx(tx *database.Tx, deviceID string) (boundDeviceDomain, int, string) {
	var d boundDeviceDomain
	var account, curSub, tunnelID, sealed, state, authHash sql.NullString
	var port int
	err := tx.QueryRow(`SELECT account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(tunnel_token,''),
       COALESCE(state,'unbound'), local_port, COALESCE(auth_token_hash,'') FROM devices WHERE id = ?`, deviceID).
		Scan(&account, &curSub, &tunnelID, &sealed, &state, &port, &authHash)
	if errors.Is(err, sql.ErrNoRows) {
		return d, http.StatusNotFound, "That Luna was not found."
	}
	if err != nil {
		return d, http.StatusInternalServerError, "Could not load that Luna."
	}
	if !account.Valid || account.String == "" || state.String != "bound" {
		return d, http.StatusNotFound, "That Luna is not linked to a customer account."
	}
	d.ID = deviceID
	d.AccountID = account.String
	d.Subdomain = curSub.String
	d.TunnelID = tunnelID.String
	d.Sealed = sealed.String
	d.State = state.String
	d.AuthTokenHash = authHash.String
	if port <= 0 {
		port = 8090
	}
	d.Port = port
	return d, 0, ""
}

func domainDevice(d boundDeviceDomain) Device {
	return Device{
		ID: d.ID, State: d.State, AuthTokenHash: d.AuthTokenHash,
		AccountID: sql.NullString{String: d.AccountID, Valid: true},
		Subdomain: d.Subdomain, TunnelID: d.TunnelID,
	}
}

// checkDomainFence compares every request-start identity field that can make a
// tunnel or DNS write belong to a different binding. The device row is locked
// for the whole check/provider/final-update sequence.
func checkDomainFence(d boundDeviceDomain, expected []Device, bearerRequest bool) (int, string) {
	if len(expected) == 0 {
		return 0, ""
	}
	want := expected[0]
	if want.AuthTokenHash != "" {
		if !bearerRequest && d.AuthTokenHash != want.AuthTokenHash {
			return http.StatusConflict, "The address changed while it was being set up. Try again."
		}
		if err := validateDeviceAuth(domainDevice(d), want); err != nil {
			switch {
			case errors.Is(err, errDeviceUnbound):
				return http.StatusForbidden, "This Luna's connection to Luna Connect is no longer active."
			case errors.Is(err, errDeviceRevoked):
				return http.StatusForbidden, "This Luna's connection to Luna Connect is no longer active."
			default:
				return http.StatusUnauthorized, "This Luna is not linked to Luna Connect. Pair it again in Settings → Luna Connect."
			}
		}
	}
	if want.ID != "" && want.ID != d.ID {
		return http.StatusNotFound, "That Luna was not found."
	}
	if want.AccountID.Valid && want.AccountID.String != d.AccountID {
		return http.StatusNotFound, "That Luna is not on this account."
	}
	if want.State != "" && want.State != d.State {
		return http.StatusNotFound, "That Luna is not on this account."
	}
	if d.Subdomain != want.Subdomain {
		return http.StatusConflict, "The address changed while it was being set up. Try again."
	}
	return 0, ""
}

// tunnelName is the Cloudflare name of a Luna's tunnel. Cloudflare allows each name once per
// account (HTTP 409), so a tunnel left behind by a removed Luna would otherwise block anyone from
// taking that name again. The device id makes the name unique to this Luna.
func tunnelName(sub, deviceID string) string {
	id := strings.TrimPrefix(deviceID, "dev_")
	if len(id) > 8 {
		id = id[:8]
	}
	return "luna-" + sub + "-" + id
}

// providerFailureStatus is what we answer when Cloudflare (or Stripe) refuses a call. Not 502:
// Cloudflare replaces any 502 or 504 from our server with its own HTML error page, so the
// person would never see our message. 503 passes through untouched.
const providerFailureStatus = http.StatusServiceUnavailable

// Address changes per account per hour. Every change deletes and recreates the
// Cloudflare tunnel and DNS records on the one credential pair every Luna
// shares, so a loop from one account can make address setup fail for everyone.
const (
	domainChangeMax    = 5
	domainChangeWindow = 3600
	domainChangeMsg    = "Too many address changes. Wait an hour, then try again."
)

// allowDomainChange records one address change for this account and reports
// whether it may go ahead. First-time setup is not a change and is not counted.
func allowDomainChange(db *database.DB, accountID string) bool {
	return allowGuess(db, "domain-change:"+accountID, domainChangeMax, domainChangeWindow)
}

func cloudflareDomainReady() (int, string) {
	if !config.Cloudflare().Ready() && !config.DevMode() {
		return 503, "Remote addresses are not set up on this Luna Connect site yet. Contact support."
	}
	if err := security.AtRestReady(); err != nil {
		slog.Error("domain ops: at-rest key not configured", "error", err)
		return 503, "Remote addresses are not set up on this Luna Connect site yet. Contact support."
	}
	return 0, ""
}

// allowedLocalPort restricts which origin ports a device may report or a
// caller may request. Anything else is refused: tunnel ingress must only ever
// point at the HTTP ports lunad actually serves on (80 on Luna OS, 443/8443
// for TLS variants, 8090 for the dev/default build).
func allowedLocalPort(port int) bool {
	switch port {
	case 80, 443, 8090, 8443:
		return true
	}
	return false
}

func domainMutationFence(d boundDeviceDomain) (string, []any) {
	return ` WHERE id = ? AND account_id = ? AND state = 'bound'
   AND COALESCE(auth_token_hash,'') = ? AND COALESCE(subdomain,'') = ? AND COALESCE(tunnel_id,'') = ?`,
		[]any{d.ID, d.AccountID, d.AuthTokenHash, d.Subdomain, d.TunnelID}
}

func restoreDomainDNS(deps Deps, cf config.CloudflareConfig, host, oldTunnelID string) {
	if oldTunnelID != "" {
		if err := deps.DNS.UpsertCNAME(cf.APIToken, cf.ZoneID, host, oldTunnelID+".cfargotunnel.com"); err != nil {
			slog.Error("domain: could not restore previous DNS record", "host", host, "err", err)
		}
		return
	}
	if err := deps.DNS.DeleteRecord(cf.APIToken, cf.ZoneID, host); err != nil {
		slog.Error("domain: could not remove unpublished DNS record", "host", host, "err", err)
	}
}

func cleanupProvisionedDomain(deps Deps, cf config.CloudflareConfig, host, tunnelID, oldTunnelID string) {
	if deps.Tunnel != nil && tunnelID != "" {
		if err := deps.Tunnel.DeleteTunnel(cf.AccountID, cf.APIToken, tunnelID); err != nil {
			slog.Error("domain: could not clean up unpublished tunnel", "tunnel_id", tunnelID, "err", err)
		}
	}
	if deps.DNS != nil {
		restoreDomainDNS(deps, cf, host, oldTunnelID)
	}
}

func reserveDomain(tx *database.Tx, sub, deviceID, accountID string) (string, error) {
	host := domainname.Hostname(sub, config.C.Server.PublicZone)
	err := database.ReserveDomain(tx, host, sub, deviceID, accountID, time.Now().Unix())
	return host, err
}

func lockDomainReservationForSub(tx *database.Tx, sub string) error {
	if sub == "" {
		return nil
	}
	return database.LockDomainReservation(tx, domainname.Hostname(sub, config.C.Server.PublicZone))
}

func releaseDomainReservationForSub(tx *database.Tx, sub, deviceID string) error {
	if sub == "" {
		return nil
	}
	return database.ReleaseDomain(tx, domainname.Hostname(sub, config.C.Server.PublicZone), deviceID)
}

func domainReservationError(err error) (int, string) {
	if errors.Is(err, database.ErrDomainReserved) {
		return http.StatusConflict, "That name is already in use. Pick another."
	}
	return http.StatusInternalServerError, "Could not save the address. Try again."
}

// syncDeviceLocalPort updates the stored origin port when Luna reports a different HTTP listen port
// (production Luna OS uses port 80; dev defaults to 8090). Reconfigures tunnel ingress when needed.
func syncDeviceLocalPort(deps Deps, deviceID string, port int) {
	_ = syncDeviceLocalPortFenced(deps, Device{ID: deviceID, State: "bound"}, port)
}

func syncDeviceLocalPortFenced(deps Deps, expected Device, port int) error {
	if !allowedLocalPort(port) {
		return nil
	}
	providers.RefreshCloudflare()
	tx, err := deps.DB.Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := database.LockDevice(tx, expected.ID); err != nil {
		return errInvalidDeviceCredential
	}
	d, status, _ := loadBoundDeviceDomainTx(tx, expected.ID)
	if status != 0 {
		return errInvalidDeviceCredential
	}
	if expected.AuthTokenHash != "" {
		if err := validateDeviceAuth(domainDevice(d), expected); err != nil {
			return err
		}
	} else if expected.AccountID.Valid && expected.AccountID.String != d.AccountID {
		return errInvalidDeviceCredential
	}
	if expected.State != "" && expected.State != d.State {
		return errInvalidDeviceCredential
	}
	if expected.AuthTokenHash != "" && (expected.Subdomain != d.Subdomain || expected.TunnelID != d.TunnelID) {
		return errDomainFence
	}
	if d.Port == port {
		if err := tx.Commit(); err != nil {
			return err
		}
		committed = true
		return nil
	}

	cf := config.Cloudflare()
	host := domainname.Hostname(d.Subdomain, config.C.Server.PublicZone)
	if err := lockDomainReservationForSub(tx, d.Subdomain); err != nil {
		return err
	}
	if d.TunnelID != "" && d.Subdomain != "" && (cf.Ready() || config.DevMode()) {
		if err := deps.Tunnel.ConfigureIngress(cf.AccountID, cf.APIToken, d.TunnelID, host, "http://127.0.0.1:"+itoa(port)); err != nil {
			slog.Warn("sync local_port: ingress update failed", "device", d.ID, "port", port, "err", err)
			return err
		}
	}
	fence, args := domainMutationFence(d)
	args = append([]any{port}, args...)
	res, err := tx.Exec(`UPDATE devices SET local_port = ?`+fence, args...)
	if err != nil {
		if d.TunnelID != "" && d.Subdomain != "" && (cf.Ready() || config.DevMode()) {
			_ = deps.Tunnel.ConfigureIngress(cf.AccountID, cf.APIToken, d.TunnelID, host, "http://127.0.0.1:"+itoa(d.Port))
		}
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		if d.TunnelID != "" && d.Subdomain != "" && (cf.Ready() || config.DevMode()) {
			_ = deps.Tunnel.ConfigureIngress(cf.AccountID, cf.APIToken, d.TunnelID, host, "http://127.0.0.1:"+itoa(d.Port))
		}
		return errDomainFence
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// applyDeviceDomain provisions tunnel+DNS for a bound device (same logic as account SetDomain).
func applyDeviceDomain(deps Deps, deviceID, sub string, port int, expected ...Device) (map[string]any, int, string) {
	providers.RefreshCloudflare()
	sub = domainname.Normalize(sub)
	if msg := domainname.Validate(sub); msg != "" {
		return nil, http.StatusBadRequest, msg
	}
	if !allowedLocalPort(port) {
		port = 8090
	}
	if status, msg := cloudflareDomainReady(); status != 0 {
		return nil, status, msg
	}

	tx, err := deps.DB.Begin()
	if err != nil {
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := database.LockDevice(tx, deviceID); err != nil {
		return nil, http.StatusNotFound, "That Luna was not found."
	}
	d, status, msg := loadBoundDeviceDomainTx(tx, deviceID)
	if status != 0 {
		return nil, status, msg
	}
	if status, msg := checkDomainFence(d, expected, false); status != 0 {
		return nil, status, msg
	}

	if d.Subdomain == sub && d.TunnelID != "" {
		out := map[string]any{"hostname": domainname.Hostname(sub, config.C.Server.PublicZone), "subdomain": sub, "device_id": deviceID}
		if d.Sealed != "" {
			if tok, err := security.OpenString(d.Sealed); err == nil && tok != "" {
				out["tunnel_token"] = tok
			}
		}
		if err := tx.Commit(); err != nil {
			return nil, http.StatusInternalServerError, "Could not load the address. Try again."
		}
		committed = true
		return out, http.StatusOK, ""
	}

	host := domainname.Hostname(sub, config.C.Server.PublicZone)
	if _, err := reserveDomain(tx, sub, deviceID, d.AccountID); err != nil {
		status, msg := domainReservationError(err)
		return nil, status, msg
	}
	cf := config.Cloudflare()
	creds, err := deps.Tunnel.CreateTunnel(cf.AccountID, cf.APIToken, tunnelName(sub, deviceID))
	if err != nil {
		slog.Error("domain: create tunnel failed", "device", deviceID, "subdomain", sub, "err", err)
		return nil, providerFailureStatus, "Could not create the secure connection. Try again."
	}
	tid, ttoken := creds.TunnelID, creds.Token
	restoreTunnelID := ""
	if d.Subdomain == sub {
		restoreTunnelID = d.TunnelID
	}
	cleanup := func() {
		cleanupProvisionedDomain(deps, cf, host, tid, restoreTunnelID)
	}
	if err := deps.Tunnel.ConfigureIngress(cf.AccountID, cf.APIToken, tid, host, "http://127.0.0.1:"+itoa(port)); err != nil {
		slog.Error("domain: configure tunnel ingress failed", "device", deviceID, "subdomain", sub, "err", err)
		cleanup()
		return nil, providerFailureStatus, "Could not set up the address. Try again."
	}
	if err := deps.DNS.UpsertCNAME(cf.APIToken, cf.ZoneID, host, tid+".cfargotunnel.com"); err != nil {
		slog.Error("domain: publish DNS record failed", "device", deviceID, "subdomain", sub, "err", err)
		cleanup()
		return nil, providerFailureStatus, "Could not publish the address. Try again."
	}
	sealedTok, err := security.SealString(ttoken)
	if err != nil {
		cleanup()
		return nil, http.StatusInternalServerError, "Could not set up the address. Try again."
	}
	fence, args := domainMutationFence(d)
	args = append([]any{sub, tid, sealedTok, port, sub}, args...)
	res, err := tx.Exec(`UPDATE devices SET subdomain = ?, tunnel_id = ?, tunnel_token = ?, local_port = ?, name = ?`+fence, args...)
	if err != nil {
		cleanup()
		if database.IsUniqueViolation(err) {
			return nil, http.StatusConflict, "That name is already in use. Pick another."
		}
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	n, err := res.RowsAffected()
	if err != nil {
		cleanup()
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	if n != 1 {
		cleanup()
		return nil, http.StatusConflict, "The address changed while it was being set up. Try again."
	}
	// Retire the previous remote resources before releasing the device fence, so
	// a replacement account cannot publish the old hostname into the deletion.
	if d.TunnelID != "" && d.TunnelID != tid {
		_ = deps.Tunnel.DeleteTunnel(cf.AccountID, cf.APIToken, d.TunnelID)
	}
	if d.Subdomain != "" && d.Subdomain != sub {
		_ = deps.DNS.DeleteRecord(cf.APIToken, cf.ZoneID, domainname.Hostname(d.Subdomain, config.C.Server.PublicZone))
		if err := releaseDomainReservationForSub(tx, d.Subdomain, d.ID); err != nil {
			cleanup()
			return nil, http.StatusInternalServerError, "Could not save the address. Try again."
		}
	}
	if err := tx.Commit(); err != nil {
		cleanup()
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	committed = true
	return map[string]any{
		"device_id": deviceID, "hostname": host, "subdomain": sub,
		"tunnel_token": ttoken,
	}, http.StatusCreated, ""
}

// regenerateDeviceTunnel deletes the old Cloudflare tunnel and creates a new one for the same subdomain.
func regenerateDeviceTunnel(deps Deps, deviceID string, expected ...Device) (map[string]any, int, string) {
	providers.RefreshCloudflare()
	if status, msg := cloudflareDomainReady(); status != 0 {
		return nil, status, msg
	}
	tx, err := deps.DB.Begin()
	if err != nil {
		return nil, http.StatusInternalServerError, "Could not save the secure connection. Try again."
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := database.LockDevice(tx, deviceID); err != nil {
		return nil, http.StatusNotFound, "That Luna was not found."
	}
	d, status, msg := loadBoundDeviceDomainTx(tx, deviceID)
	if status != 0 {
		return nil, status, msg
	}
	if status, msg := checkDomainFence(d, expected, len(expected) > 0); status != 0 {
		return nil, status, msg
	}
	if d.Subdomain == "" {
		return nil, http.StatusConflict, "This Luna has no address yet. Set an address first."
	}

	host := domainname.Hostname(d.Subdomain, config.C.Server.PublicZone)
	if _, err := reserveDomain(tx, d.Subdomain, deviceID, d.AccountID); err != nil {
		status, msg := domainReservationError(err)
		return nil, status, msg
	}
	cf := config.Cloudflare()
	creds, err := deps.Tunnel.CreateTunnel(cf.AccountID, cf.APIToken, tunnelName(d.Subdomain, deviceID))
	if err != nil {
		slog.Error("domain: regenerate tunnel failed", "device", deviceID, "err", err)
		return nil, providerFailureStatus, "Could not create the secure connection. Try again."
	}
	tid, ttoken := creds.TunnelID, creds.Token
	cleanup := func() {
		cleanupProvisionedDomain(deps, cf, host, tid, d.TunnelID)
	}
	if err := deps.Tunnel.ConfigureIngress(cf.AccountID, cf.APIToken, tid, host, "http://127.0.0.1:"+itoa(d.Port)); err != nil {
		slog.Error("domain: regenerate ingress failed", "device", deviceID, "err", err)
		cleanup()
		return nil, providerFailureStatus, "Could not set up the address. Try again."
	}
	if err := deps.DNS.UpsertCNAME(cf.APIToken, cf.ZoneID, host, tid+".cfargotunnel.com"); err != nil {
		slog.Error("domain: regenerate DNS record failed", "device", deviceID, "err", err)
		cleanup()
		return nil, providerFailureStatus, "Could not publish the address. Try again."
	}
	sealedTok, err := security.SealString(ttoken)
	if err != nil {
		cleanup()
		return nil, http.StatusInternalServerError, "Could not save the secure connection. Try again."
	}
	fence, args := domainMutationFence(d)
	args = append([]any{tid, sealedTok}, args...)
	res, err := tx.Exec(`UPDATE devices SET tunnel_id = ?, tunnel_token = ?`+fence, args...)
	if err != nil {
		cleanup()
		return nil, http.StatusInternalServerError, "Could not save the secure connection. Try again."
	}
	n, err := res.RowsAffected()
	if err != nil {
		cleanup()
		return nil, http.StatusInternalServerError, "Could not save the secure connection. Try again."
	}
	if n != 1 {
		cleanup()
		return nil, http.StatusConflict, "The address changed while it was being set up. Try again."
	}
	if d.TunnelID != "" && d.TunnelID != tid {
		_ = deps.Tunnel.DeleteTunnel(cf.AccountID, cf.APIToken, d.TunnelID)
	}
	if err := tx.Commit(); err != nil {
		cleanup()
		return nil, http.StatusInternalServerError, "Could not save the secure connection. Try again."
	}
	committed = true
	return map[string]any{
		"device_id":    deviceID,
		"hostname":     host,
		"subdomain":    d.Subdomain,
		"tunnel_id":    tid,
		"tunnel_token": ttoken,
		"regenerated":  true,
	}, http.StatusOK, ""
}

// moveDeviceDomain reuses the device's current tunnel while changing its
// hostname. It is fenced by the bearer that DeviceAuth admitted.
func moveDeviceDomain(deps Deps, expected Device, sub string) (map[string]any, int, string) {
	sub = domainname.Normalize(sub)
	if msg := domainname.Validate(sub); msg != "" {
		return nil, http.StatusBadRequest, msg
	}
	providers.RefreshCloudflare()
	tx, err := deps.DB.Begin()
	if err != nil {
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := database.LockDevice(tx, expected.ID); err != nil {
		return nil, http.StatusUnauthorized, "This Luna is not linked to Luna Connect. Pair it again in Settings → Luna Connect."
	}
	d, status, _ := loadBoundDeviceDomainTx(tx, expected.ID)
	if status != 0 {
		return nil, http.StatusUnauthorized, "This Luna is not linked to Luna Connect. Pair it again in Settings → Luna Connect."
	}
	if status, msg := checkDomainFence(d, []Device{expected}, true); status != 0 {
		return nil, status, msg
	}
	token, err := security.OpenString(d.Sealed)
	if err != nil || token == "" || d.TunnelID == "" {
		return nil, http.StatusConflict, "Pick a name on the Luna Connect website first."
	}
	if d.Subdomain == sub {
		if err := tx.Commit(); err != nil {
			return nil, http.StatusInternalServerError, "Could not load the address. Try again."
		}
		committed = true
		return map[string]any{"hostname": domainname.Hostname(sub, config.C.Server.PublicZone), "subdomain": sub, "tunnel_token": token}, http.StatusOK, ""
	}

	oldHost := domainname.Hostname(d.Subdomain, config.C.Server.PublicZone)
	newHost := domainname.Hostname(sub, config.C.Server.PublicZone)
	if _, err := reserveDomain(tx, sub, d.ID, d.AccountID); err != nil {
		status, msg := domainReservationError(err)
		return nil, status, msg
	}
	cf := config.Cloudflare()
	restore := func() {
		_ = deps.Tunnel.ConfigureIngress(cf.AccountID, cf.APIToken, d.TunnelID, oldHost, "http://127.0.0.1:"+itoa(d.Port))
		restoreDomainDNS(deps, cf, oldHost, d.TunnelID)
	}
	if err := deps.Tunnel.ConfigureIngress(cf.AccountID, cf.APIToken, d.TunnelID, newHost, "http://127.0.0.1:"+itoa(d.Port)); err != nil {
		slog.Error("domain: move ingress failed", "device", d.ID, "subdomain", sub, "err", err)
		return nil, providerFailureStatus, "Could not move the address. Try again."
	}
	if err := deps.DNS.UpsertCNAME(cf.APIToken, cf.ZoneID, newHost, d.TunnelID+".cfargotunnel.com"); err != nil {
		slog.Error("domain: move DNS record failed", "device", d.ID, "subdomain", sub, "err", err)
		restore()
		return nil, providerFailureStatus, "Could not publish the new address. Try again."
	}
	fence, args := domainMutationFence(d)
	args = append([]any{sub, sub}, args...)
	res, err := tx.Exec(`UPDATE devices SET subdomain = ?, name = ?`+fence, args...)
	if err != nil {
		restore()
		if database.IsUniqueViolation(err) {
			return nil, http.StatusConflict, "That name is already in use. Pick another."
		}
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	n, err := res.RowsAffected()
	if err != nil {
		restore()
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	if n != 1 {
		restore()
		return nil, http.StatusConflict, "The address changed while it was being set up. Try again."
	}
	if d.Subdomain != "" && d.Subdomain != sub {
		_ = deps.DNS.DeleteRecord(cf.APIToken, cf.ZoneID, oldHost)
		if err := releaseDomainReservationForSub(tx, d.Subdomain, d.ID); err != nil {
			restore()
			return nil, http.StatusInternalServerError, "Could not save the address. Try again."
		}
	}
	if err := tx.Commit(); err != nil {
		restore()
		return nil, http.StatusInternalServerError, "Could not save the address. Try again."
	}
	committed = true
	return map[string]any{"hostname": newHost, "subdomain": sub, "tunnel_token": token}, http.StatusOK, ""
}
