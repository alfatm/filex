package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	authlocal "github.com/brf-tech/filex/backend/internal/auth/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// TestLoginTOTPEnforcement verifies that once a user has TOTP enabled, the
// password alone is no longer sufficient — a valid second factor is required
// and no session cookie is issued otherwise.
func TestLoginTOTPEnforcement(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	ctx := context.Background()

	email, password := testutil.SeedAdmin(t, store)
	u, err := store.GetUserByEmail(ctx, email)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}

	const secret = "JBSWY3DPEHPK3PXP" // valid base32, no padding
	if err := store.SetTotpPendingSecret(ctx, u.ID, secret, []string{"AAAAA-BBBBB"}); err != nil {
		t.Fatalf("set pending: %v", err)
	}
	if err := store.ActivateTotp(ctx, u.ID); err != nil {
		t.Fatalf("activate: %v", err)
	}

	login := func(body map[string]string) (*http.Response, bool) {
		t.Helper()
		raw, _ := json.Marshal(body)
		resp, err := client.Post(srv.URL+"/api/auth/login", "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("login post: %v", err)
		}
		hasCookie := false
		for _, c := range resp.Cookies() {
			if c.Name == authlocal.SessionCookieName && c.Value != "" {
				hasCookie = true
			}
		}
		return resp, hasCookie
	}

	// 1. Correct password, NO code → rejected, no cookie.
	resp, cookie := login(map[string]string{"email": email, "password": password})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || cookie {
		t.Fatalf("missing TOTP should be 401 with no cookie; got %d cookie=%v", resp.StatusCode, cookie)
	}

	// 2. Correct password, WRONG code → rejected.
	resp, cookie = login(map[string]string{"email": email, "password": password, "totp": "000000"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || cookie {
		t.Fatalf("wrong TOTP should be 401 with no cookie; got %d cookie=%v", resp.StatusCode, cookie)
	}

	// 3. Correct password + valid live code → success + cookie.
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate code: %v", err)
	}
	resp, cookie = login(map[string]string{"email": email, "password": password, "totp": code})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !cookie {
		t.Fatalf("valid TOTP should be 200 with cookie; got %d cookie=%v", resp.StatusCode, cookie)
	}
}

// TestLoginNoTOTPUnaffected confirms users without TOTP still log in with
// just email + password.
func TestLoginNoTOTPUnaffected(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	testutil.SeedRegularUser(t, store, "plain@test.local", "PlainPass!1")

	raw, _ := json.Marshal(map[string]string{"email": "plain@test.local", "password": "PlainPass!1"})
	resp, err := client.Post(srv.URL+"/api/auth/login", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}

// totpFixture enables TOTP on the seeded admin with the given recovery codes
// and returns a login helper reporting (status, session cookie issued).
func totpFixture(t *testing.T, recovery []string) (srv string, client *http.Client, email, password string, login func(totp string) (int, bool)) {
	t.Helper()
	server, client, store := testutil.NewTestServer(t)
	ctx := context.Background()
	email, password = testutil.SeedAdmin(t, store)
	u, err := store.GetUserByEmail(ctx, email)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if err := store.SetTotpPendingSecret(ctx, u.ID, "JBSWY3DPEHPK3PXP", recovery); err != nil {
		t.Fatalf("set pending: %v", err)
	}
	if err := store.ActivateTotp(ctx, u.ID); err != nil {
		t.Fatalf("activate: %v", err)
	}
	login = func(code string) (int, bool) {
		t.Helper()
		raw, _ := json.Marshal(map[string]string{"email": email, "password": password, "totp": code})
		resp, err := client.Post(server.URL+"/api/auth/login", "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("login post: %v", err)
		}
		defer resp.Body.Close()
		hasCookie := false
		for _, c := range resp.Cookies() {
			if c.Name == authlocal.SessionCookieName && c.Value != "" {
				hasCookie = true
			}
		}
		return resp.StatusCode, hasCookie
	}
	return server.URL, client, email, password, login
}

// A recovery code stands in for the TOTP exactly once: it signs in, spent in
// any spelling (case, hyphen, spaces), and is refused the second time.
func TestLoginTOTPRecoveryCode_UsedOnce(t *testing.T) {
	_, _, _, _, login := totpFixture(t, []string{"ABCDE-FGHIJ", "KLMNP-QRSTU"})

	if status, cookie := login("abcde fghij"); status != http.StatusOK || !cookie {
		t.Fatalf("recovery code should sign in; got %d cookie=%v", status, cookie)
	}
	if status, cookie := login("ABCDE-FGHIJ"); status != http.StatusUnauthorized || cookie {
		t.Fatalf("a spent recovery code should be 401 with no cookie; got %d cookie=%v", status, cookie)
	}
	// The other code is untouched.
	if status, cookie := login("KLMNP-QRSTU"); status != http.StatusOK || !cookie {
		t.Fatalf("the remaining recovery code should still sign in; got %d cookie=%v", status, cookie)
	}
}

func TestLoginTOTPRecoveryCode_Wrong_401(t *testing.T) {
	_, _, _, _, login := totpFixture(t, []string{"ABCDE-FGHIJ"})
	if status, cookie := login("ZZZZZ-ZZZZZ"); status != http.StatusUnauthorized || cookie {
		t.Fatalf("unknown recovery code should be 401 with no cookie; got %d cookie=%v", status, cookie)
	}
}

// Six digits are a TOTP, never a recovery code — even when the stored list
// (artificially) holds that very string, the shape gate refuses it.
func TestLoginTOTPRecoveryCode_SixDigitsNotRecovery(t *testing.T) {
	_, _, _, _, login := totpFixture(t, []string{"000000"})
	if status, cookie := login("000000"); status != http.StatusUnauthorized || cookie {
		t.Fatalf("a six-digit code must not be matched against recovery codes; got %d cookie=%v", status, cookie)
	}
}

// Someone who lost the device turns 2FA off with password + recovery code.
func TestTotpDisable_RecoveryCode(t *testing.T) {
	srv, client, email, password, login := totpFixture(t, []string{"ABCDE-FGHIJ", "KLMNP-QRSTU"})
	// Sign in with one code (the jar keeps the cookie), disable with the other.
	if status, cookie := login("ABCDE-FGHIJ"); status != http.StatusOK || !cookie {
		t.Fatalf("login: got %d cookie=%v", status, cookie)
	}
	post := func(code string) int {
		raw, _ := json.Marshal(map[string]string{"password": password, "code": code})
		resp, err := client.Post(srv+"/api/auth/totp/disable", "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("disable post: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if status := post("ABCDE-FGHIJ"); status != http.StatusUnauthorized {
		t.Fatalf("a spent recovery code must not disable TOTP; got %d", status)
	}
	if status := post("klmnp-qrstu"); status != http.StatusOK {
		t.Fatalf("recovery code should disable TOTP; got %d", status)
	}
	// TOTP is off: password alone signs in again.
	raw, _ := json.Marshal(map[string]string{"email": email, "password": password})
	resp, err := client.Post(srv+"/api/auth/login", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("after disable, password-only login should be 200; got %d", resp.StatusCode)
	}
}
