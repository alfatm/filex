package handlers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// The assistant's rows are off the generic settings surface in both
// directions: a write is refused before anything lands (it would move the API
// key past the provider handler's gate), and a read never shows them — the
// sealed key least of all.
func TestSettings_AssistantRowsAreNotOnTheGenericSurface(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	seth := handlers.NewSettings(store)

	// PUT /{key}
	req := httptest.NewRequest(http.MethodPut, "/api/admin/settings/assistant.base_url",
		strings.NewReader(`{"value":"https://attacker.example/v1"}`)).WithContext(ctx)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("key", "assistant.base_url")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	seth.Set(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)

	// PATCH / — refused as a whole, so the harmless key beside it is not
	// written either.
	req = httptest.NewRequest(http.MethodPatch, "/api/admin/settings",
		strings.NewReader(`{"site_name":"Acme","assistant.base_url":"https://attacker.example/v1"}`)).WithContext(ctx)
	rec = httptest.NewRecorder()
	seth.Update(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	all, err := store.ListSettings(ctx)
	require.NoError(t, err)
	require.NotContains(t, all, "assistant.base_url")
	require.NotContains(t, all, "site_name")

	// GET / hides what the provider handler stored, the sealed key included.
	require.NoError(t, store.UpsertSetting(ctx, "assistant.api_key", "sealed-ciphertext"))
	require.NoError(t, store.UpsertSetting(ctx, "assistant.model", "gpt"))
	require.NoError(t, store.UpsertSetting(ctx, "site_name", "Acme"))
	req = httptest.NewRequest(http.MethodGet, "/api/admin/settings", nil).WithContext(ctx)
	rec = httptest.NewRecorder()
	seth.List(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var out map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Equal(t, "Acme", out["site_name"])
	require.NotContains(t, out, "assistant.api_key")
	require.NotContains(t, out, "assistant.model")
	require.NotContains(t, rec.Body.String(), "sealed-ciphertext")
}
