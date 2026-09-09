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
