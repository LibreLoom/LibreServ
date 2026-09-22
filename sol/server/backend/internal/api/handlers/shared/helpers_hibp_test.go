package shared

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHIBPHTTPClientRefusesRedirects(t *testing.T) {
	if hibpHTTPClient.CheckRedirect == nil {
		t.Fatal("expected CheckRedirect on hibpHTTPClient")
	}
	err := hibpHTTPClient.CheckRedirect(nil, nil)
	if err != errHIBPRedirect {
		t.Fatalf("CheckRedirect = %v, want %v", err, errHIBPRedirect)
	}
}

func TestCheckBreachedPasswordDoesNotFollowRedirect(t *testing.T) {
	followed := false
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("DEADBEEF:1\n"))
	}))
	t.Cleanup(final.Close)

	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL+"/range/FFFFF", http.StatusFound)
	}))
	t.Cleanup(redir.Close)

	prev := hibpRangeURL
	SetHIBPRangeURL(redir.URL + "/range/")
	t.Cleanup(func() { SetHIBPRangeURL(prev) })

	breached, err := CheckBreachedPassword("password")
	if err == nil {
		t.Fatal("expected redirect refusal error, got nil")
	}
	if breached {
		t.Fatal("expected breached=false when redirect is refused")
	}
	if followed {
		t.Fatal("HIBP client followed a redirect")
	}
}
