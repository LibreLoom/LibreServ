package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// domainChangeFixture registers, verifies and binds one account with one Luna.
func domainChangeFixture(t *testing.T, email string) (AccountHandler, DeviceHandler, *http.Cookie, string, string) {
	t.Helper()
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, email)
	verifyEmailFor(t, acctH, email)
	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	if rec := withVerifiedAccount(acctH, devH.Bind, bindReq); rec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", rec.Code, rec.Body.String())
	}
	return acctH, devH, cookie, devID, code
}

func setAddress(t *testing.T, acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie, devID, name string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"`+name+`"}`))
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", devID)
	return withVerifiedAccount(acctH, devH.SetDomain, req)
}

// Every address change deletes and recreates Cloudflare tunnels and DNS records
// on the one credential pair every Luna shares. One account must not be able to
// loop that; the first address is setup and stays free.
func TestDomainChangesAreLimitedPerAccount(t *testing.T) {
	acctH, devH, cookie, devID, _ := domainChangeFixture(t, "domain-limit@b.co")

	if rec := setAddress(t, acctH, devH, cookie, devID, "firstbox"); rec.Code != http.StatusCreated {
		t.Fatalf("first address %d %s", rec.Code, rec.Body.String())
	}
	names := []string{"box0", "box1", "box2", "box3", "box4"}
	for _, name := range names {
		if rec := setAddress(t, acctH, devH, cookie, devID, name); rec.Code != http.StatusCreated {
			t.Fatalf("change to %s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	blocked := setAddress(t, acctH, devH, cookie, devID, "box5")
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("over the limit %d %s", blocked.Code, blocked.Body.String())
	}
	if !strings.Contains(blocked.Body.String(), "Too many address changes.") {
		t.Fatalf("plain sentence missing: %s", blocked.Body.String())
	}
	// Asking for the address it already has is not a change and still answers.
	if rec := setAddress(t, acctH, devH, cookie, devID, "box4"); rec.Code != http.StatusOK {
		t.Fatalf("same address %d %s", rec.Code, rec.Body.String())
	}
}

// The Luna's own POST /domain moves an address on the same shared token, so it
// draws from the same per-account allowance.
func TestLunaDomainChangesShareTheAccountLimit(t *testing.T) {
	acctH, devH, cookie, devID, code := domainChangeFixture(t, "luna-domain-limit@b.co")
	if rec := setAddress(t, acctH, devH, cookie, devID, "firstbox"); rec.Code != http.StatusCreated {
		t.Fatalf("first address %d %s", rec.Code, rec.Body.String())
	}
	change := func(name string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/domain", bytes.NewBufferString(`{"subdomain":"`+name+`"}`))
		req.Header.Set("Authorization", "Bearer "+code)
		rec := httptest.NewRecorder()
		devH.DeviceAuth(http.HandlerFunc(devH.Domain)).ServeHTTP(rec, req)
		return rec
	}
	for _, name := range []string{"box0", "box1", "box2", "box3", "box4"} {
		if rec := change(name); rec.Code != http.StatusOK {
			t.Fatalf("change to %s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	blocked := change("box5")
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("over the limit %d %s", blocked.Code, blocked.Body.String())
	}
	if !strings.Contains(blocked.Body.String(), "Too many address changes.") {
		t.Fatalf("plain sentence missing: %s", blocked.Body.String())
	}
}
