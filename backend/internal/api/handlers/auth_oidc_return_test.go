package handlers

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// The value reaches an HTML bounce page and a Location header, so anything
// that is not plainly a same-origin path has to come back as the default.
func TestSafeReturnTo(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{"empty falls back", "", "/admin/"},
		{"app root", "/", "/"},
		{"app path", "/files/main/Design", "/files/main/Design"},
		{"console", "/admin/", "/admin/"},
		{"query kept", "/?tab=recent", "/?tab=recent"},
		{"absolute url", "https://evil.example/x", "/admin/"},
		{"scheme relative", "//evil.example/x", "/admin/"},
		{"backslash authority", `/\evil.example`, "/admin/"},
		{"no leading slash", "files", "/admin/"},
		{"header split", "/files\r\nLocation: https://evil.example", "/admin/"},
		{"overlong", "/" + string(make([]byte, 512)), "/admin/"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, safeReturnTo(tc.in))
		})
	}
}

// A failed hand-off has to land on the sign-in screen the person started from:
// an app user bounced to /admin/login is asked to sign in to a console they may
// have no access to at all.
func TestOIDCLoginPage(t *testing.T) {
	assert.Equal(t, "/admin/login", oidcLoginPage("/admin/"))
	assert.Equal(t, "/admin/login", oidcLoginPage("/admin/settings"))
	assert.Equal(t, "/login", oidcLoginPage("/"))
	assert.Equal(t, "/login", oidcLoginPage("/files/main"))
}
