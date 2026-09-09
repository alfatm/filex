package assistant

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The client never follows a redirect off the configured host: Go strips
// Authorization on such a hop but not x-api-key, and either header is the key.
func TestClientRefusesRedirectOffHost(t *testing.T) {
	var reached atomic.Bool
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Store(true)
	}))
	defer sink.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer provider.Close()

	req, err := http.NewRequest(http.MethodPost, provider.URL+"/v1/messages", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("x-api-key", "sk-secret")
	resp, err := New(nil, nil).client.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatal("a redirect off the provider host was followed")
	}
	if reached.Load() {
		t.Fatal("the request reached the redirect target")
	}
}

// The same rule, one level down and on the half an httptest server cannot
// stage: a redirect that keeps the host but drops from https to http.
//
// Go's own redirect handling strips Authorization only when the HOST changes,
// so the downgrade used to be followed — and x-api-key is never stripped, so
// the key went out in clear text to the same name the operator had configured.
func TestRefuseRedirectDowngradingTheScheme(t *testing.T) {
	origin, err := http.NewRequest(http.MethodPost, "https://api.provider.test/v1/messages", nil)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := http.NewRequest(http.MethodPost, "http://api.provider.test/v1/messages", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := refuseOffHostRedirect(plain, []*http.Request{origin}); err == nil {
		t.Fatal("an https to http redirect on the same host was followed")
	}

	// The refusal is about the scheme, not about redirects: the same origin is
	// still followed, which is what makes the assertion above mean something.
	elsewhere, err := http.NewRequest(http.MethodPost, "https://api.provider.test/v2/messages", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := refuseOffHostRedirect(elsewhere, []*http.Request{origin}); err != nil {
		t.Fatalf("a same-origin redirect must still be followed: %v", err)
	}
}
