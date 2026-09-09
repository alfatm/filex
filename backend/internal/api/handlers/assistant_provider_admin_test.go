package handlers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/secretbox"
	"github.com/brf-tech/filex/backend/internal/tenant"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// A stored key is bound to the address it was entered for. Moving base_url or
// provider without re-entering it is refused, so the key on file is never
// sent to an address the operator did not enter it for — which is how the
// page could otherwise be used to read a key GET never returns.
func TestAssistantProvider_MovingEndpointRequiresKey(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	box, err := secretbox.New("test-secret-key")
	require.NoError(t, err)
	h := handlers.NewAssistantProviderAdmin(store, box, nil)

	put := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/api/admin/assistant/provider", strings.NewReader(body)).WithContext(ctx)
		rec := httptest.NewRecorder()
		h.Put(rec, req)
		return rec
	}
	baseURL := func() string {
		v, err := store.GetSetting(ctx, assistant.BaseURLSetting.Key)
		require.NoError(t, err)
		return v
	}

	// Key and address entered together.
	rec := put(`{"base_url":"https://llm.example.com/v1","api_key":"sk-real"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.True(t, assistant.HasKey(ctx, store))

	// Moving the address alone → refused, nothing written.
	rec = put(`{"base_url":"https://attacker.example/v1"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "https://llm.example.com/v1", baseURL())
	require.True(t, assistant.HasKey(ctx, store))

	// The redaction marker means "unchanged"; it is not a key.
	rec = put(`{"base_url":"https://attacker.example/v1","api_key":"***"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, "https://llm.example.com/v1", baseURL())

	// Switching provider moves the default endpoint and the header: same rule.
	rec = put(`{"provider":"anthropic"}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)

	// Re-sending the same address is not a move.
	rec = put(`{"base_url":"https://llm.example.com/v1","model":"gpt"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Moving WITH a key is fine: it is the operator's own key going there.
	rec = put(`{"base_url":"https://other.example.com/v1","api_key":"sk-other"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "https://other.example.com/v1", baseURL())

	// Removing the key in the same request is fine too.
	rec = put(`{"base_url":"https://third.example.com/v1","api_key":""}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.False(t, assistant.HasKey(ctx, store))
	require.Equal(t, "https://third.example.com/v1", baseURL())

	// The response says whether a key is stored, never what it is.
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.NotContains(t, out, "api_key")
	require.NotContains(t, rec.Body.String(), "sk-")
}

// A tenant admin does not reach the instance-wide provider at all.
func TestAssistantProvider_TenantAdminForbidden(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	box, err := secretbox.New("test-secret-key")
	require.NoError(t, err)
	h := handlers.NewAssistantProviderAdmin(store, box, nil)

	ctx := tenant.WithScope(context.Background(), &tenant.Scope{ProviderID: 42})
	req := httptest.NewRequest(http.MethodPut, "/api/admin/assistant/provider",
		strings.NewReader(`{"base_url":"https://attacker.example/v1"}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	h.Put(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)
}
