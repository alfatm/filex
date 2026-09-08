// Package handlers — assistant_provider_admin.go
//
//	GET  /api/admin/assistant/provider        (supertenant)  what is configured
//	PUT  /api/admin/assistant/provider        (supertenant)  configure it
//	POST /api/admin/assistant/provider/test   (supertenant)  ask the model once
//
// One provider serves the whole installation — there is no per-tenant model —
// so this is a supertenant surface for the same reason /api/admin/external is:
// whoever holds it decides where every tenant's questions are sent and on whose
// account they are billed.
//
// # The key is written and never read back
//
// GET reports whether a key is stored, never the key, and PUT accepts the
// redaction marker as "leave it alone" — the same contract the external
// services page already uses, because an admin form that re-sends what it was
// shown would otherwise replace a working key with three asterisks.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/dbsetting"
	"github.com/brf-tech/filex/backend/internal/secretbox"
)

// assistantIsInstanceWide is the refusal a tenant admin reads.
const assistantIsInstanceWide = "the assistant's model provider applies to the whole instance and is managed by the platform operator"

// testPrompt is what the Test button asks. Short on purpose: it proves the
// endpoint, the key, the model name and the streaming shape all work, and
// costs a handful of tokens to do it.
const testPrompt = "Reply with the single word OK."

// testTimeout bounds the Test button. An operator is watching the page.
const testTimeout = 30 * time.Second

// testAnswerLimit is how much of the reply is quoted back to the operator.
const testAnswerLimit = 200

// AssistantProviderAdmin handles the model configuration.
type AssistantProviderAdmin struct {
	Store db.Store
	Box   *secretbox.Box
	AI    *assistant.Service
}

// NewAssistantProviderAdmin constructs the handler.
func NewAssistantProviderAdmin(store db.Store, box *secretbox.Box, ai *assistant.Service) *AssistantProviderAdmin {
	return &AssistantProviderAdmin{Store: store, Box: box, AI: ai}
}

// Get returns the configuration in force, with the reason it is not usable
// when it is not.
func (h *AssistantProviderAdmin) Get(w http.ResponseWriter, r *http.Request) {
	if !requireSupertenant(w, r, assistantIsInstanceWide) {
		return
	}
	cfg := assistant.Load(r.Context(), h.Store, h.Box)
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":          cfg.Enabled,
		"provider":         cfg.Provider,
		"base_url":         cfg.BaseURL,
		"endpoint":         cfg.Endpoint(),
		"model":            cfg.Model,
		"turns_per_minute": cfg.TurnsPerMinute,
		"has_key":          assistant.HasKey(r.Context(), h.Store),
		"ready":            cfg.Ready(),
		"problem":          cfg.Problem,
		"providers":        []string{assistant.ProviderOpenAI, assistant.ProviderAnthropic},
	})
}

type assistantProviderReq struct {
	Enabled        *bool   `json:"enabled,omitempty"`
	Provider       *string `json:"provider,omitempty"`
	BaseURL        *string `json:"base_url,omitempty"`
	Model          *string `json:"model,omitempty"`
	TurnsPerMinute *int    `json:"turns_per_minute,omitempty"`
	// APIKey is plaintext from the form. The redaction marker means "unchanged";
	// an empty string means "remove the key".
	APIKey *string `json:"api_key,omitempty"`
}

// Put writes the configuration. Every field is validated by the spec that owns
// it, so a value this accepts is one the read path will still honour.
func (h *AssistantProviderAdmin) Put(w http.ResponseWriter, r *http.Request) {
	if !requireSupertenant(w, r, assistantIsInstanceWide) {
		return
	}
	var req assistantProviderReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	ctx := r.Context()
	if req.Provider != nil {
		value, err := assistant.ProviderSetting.Canonical(*req.Provider)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := h.Store.UpsertSetting(ctx, assistant.ProviderSetting.Key, value); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if req.BaseURL != nil {
		value, err := assistant.BaseURLSetting.Canonical(*req.BaseURL)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := h.Store.UpsertSetting(ctx, assistant.BaseURLSetting.Key, value); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if req.Model != nil {
		if err := h.Store.UpsertSetting(ctx, assistant.ModelSetting.Key, strings.TrimSpace(*req.Model)); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if req.TurnsPerMinute != nil {
		if err := assistant.RateLimitSetting.Validate(*req.TurnsPerMinute); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := h.Store.UpsertSetting(ctx, assistant.RateLimitSetting.Key, strconv.Itoa(*req.TurnsPerMinute)); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	if req.APIKey != nil && *req.APIKey != redactedSecret {
		if err := assistant.StoreKey(ctx, h.Store, h.Box, *req.APIKey); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	// Last, so a provider that is switched on in the same request is switched
	// on against the configuration that request just wrote.
	if req.Enabled != nil {
		if err := h.Store.UpsertSetting(ctx, assistant.EnabledSetting.Key, dbsetting.FormatBool(*req.Enabled)); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	h.Get(w, r)
}

// Test asks the configured model one short question and reports what came
// back. It is the difference between "the form is saved" and "the assistant
// works", and those are not the same thing: a wrong model name or a revoked
// key is only visible at the moment somebody calls the provider.
func (h *AssistantProviderAdmin) Test(w http.ResponseWriter, r *http.Request) {
	if !requireSupertenant(w, r, assistantIsInstanceWide) {
		return
	}
	if h.AI == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "no assistant service is running"})
		return
	}
	cfg := h.AI.Config(r.Context())
	if !cfg.Ready() {
		reason := cfg.Problem
		if reason == "" {
			reason = "the assistant is switched off"
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": reason})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), testTimeout)
	defer cancel()
	var answer strings.Builder
	// No tools: the Test button asks whether the endpoint, the key and the model
	// name work, and a model that went looking through somebody's files to
	// answer it would be doing something nobody asked for.
	err := h.AI.Ask(ctx, cfg, nil, []assistant.Message{{Role: "user", Content: testPrompt}}, func(event assistant.Event) error {
		if event.Type == assistant.EventText {
			answer.WriteString(event.Delta)
		}
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	reply := strings.TrimSpace(answer.String())
	if len(reply) > testAnswerLimit {
		reply = reply[:testAnswerLimit]
	}
	// An empty answer is not a success: the call went through and the model
	// said nothing, which an operator has to see rather than a green tick.
	writeJSON(w, http.StatusOK, map[string]any{"ok": reply != "", "model": cfg.Model, "reply": reply})
}
