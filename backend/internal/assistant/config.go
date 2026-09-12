// Package assistant is the LLM half of the file assistant: what model answers,
// where it is reached, and under what standing instructions.
//
// # Where the configuration lives, and why not next to the other services
//
// filex already has a home for "a third-party endpoint plus a credential":
// the external_services table behind /api/admin/external. The assistant does
// NOT live there, for two reasons that are specific to it:
//
//   - every enabled row in that table is health-probed with an unauthenticated
//     GET once an hour, and a model API answers that with 401 or 404 forever —
//     the operator would be told the assistant is unreachable while it works;
//   - the probe result is published on /api/capabilities, which is PUBLIC and
//     pre-auth, so the row would advertise to anonymous callers that this
//     installation talks to a model provider, and at which address.
//
// So the four settings are dbsetting rows like every other admin-editable
// setting, and the key is sealed (secretbox) into a fifth. Sealing matters
// here even though external_services stores its secret in the clear: this
// credential is billable and reaches a third party, and the database travels
// into backups by design.
package assistant

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/brf-tech/filex/backend/internal/dbsetting"
	"github.com/brf-tech/filex/backend/internal/secretbox"
)

// The providers this package can speak to. One is configured at a time —
// there is no fallback chain, on purpose: a silent switch to a second model
// would change what the assistant does with a person's files without saying so.
const (
	ProviderOpenAI    = "openai"
	ProviderAnthropic = "anthropic"
)

// Default endpoints, applied when the operator sets no base URL. An
// openai-compatible server (vLLM, Ollama, LiteLLM, a gateway) is configured by
// pointing base_url at it and leaving the provider on "openai".
const (
	DefaultOpenAIBaseURL    = "https://api.openai.com/v1"
	DefaultAnthropicBaseURL = "https://api.anthropic.com/v1"
)

// apiKeySetting is where the sealed key is stored. It is not a StringSpec:
// every spec in dbsetting stores what it is given, and what this row must hold
// is ciphertext.
const apiKeySetting = "assistant.api_key"

// apiKeyEnv seeds the key on first boot, the same way every other setting is
// seeded — and with the same one-shot rule: once a row exists the variable is
// inert. It exists so a development stand can be provisioned from compose.
const apiKeyEnv = "FILEX_ASSISTANT_API_KEY"

// The admin-editable settings.
var (
	// EnabledSetting is the operator's switch. Off is the default: a fresh
	// install must not start talking to a model provider because somebody
	// happened to have a key in the environment.
	EnabledSetting = dbsetting.BoolSpec{
		Key:     "assistant.enabled",
		EnvVar:  "FILEX_ASSISTANT_ENABLED",
		Default: false,
	}
	// ProviderSetting picks the wire protocol, not the vendor: "openai" is
	// every openai-compatible server as well as OpenAI itself.
	ProviderSetting = dbsetting.StringSpec{
		Key:       "assistant.provider",
		EnvVar:    "FILEX_ASSISTANT_PROVIDER",
		Default:   ProviderOpenAI,
		Normalize: func(raw string) string { return strings.ToLower(strings.TrimSpace(raw)) },
		Check:     dbsetting.OneOf(ProviderOpenAI, ProviderAnthropic),
	}
	// BaseURLSetting is empty for "the provider's own endpoint".
	BaseURLSetting = dbsetting.StringSpec{
		Key:     "assistant.base_url",
		EnvVar:  "FILEX_ASSISTANT_BASE_URL",
		Default: "",
		Check:   checkBaseURL,
	}
	// ModelSetting has no default. A model name is not something software can
	// guess on an operator's behalf: it decides both the bill and the quality,
	// and every provider spells its own differently.
	ModelSetting = dbsetting.StringSpec{
		Key:     "assistant.model",
		EnvVar:  "FILEX_ASSISTANT_MODEL",
		Default: "",
	}
	// RateLimitSetting is the loop-breaker, not an economy measure. An agent
	// that has talked itself into a circle re-asks the same question as fast
	// as the network allows; this is the ceiling that stops it. It counts
	// TURNS STARTED per account per minute.
	RateLimitSetting = dbsetting.IntSpec{
		Key:     "assistant.turns_per_minute",
		EnvVar:  "FILEX_ASSISTANT_TURNS_PER_MINUTE",
		Default: 20,
		Min:     1,
		Max:     600,
		Unit:    "turns per minute",
	}
)

// Settings is the seed list, for one SeedAll call at boot.
func Settings() []dbsetting.Seeder {
	return []dbsetting.Seeder{EnabledSetting, ProviderSetting, BaseURLSetting, ModelSetting, RateLimitSetting}
}

// checkBaseURL refuses the shapes an operator actually types. Empty is legal
// ("use the provider's own endpoint"); anything else has to be an absolute
// http(s) URL, because a bare host is silently unusable and would be
// discovered at the first question somebody asks.
func checkBaseURL(v string) error {
	if v == "" {
		return nil
	}
	if !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
		return fmt.Errorf("base URL must start with http:// or https://")
	}
	return nil
}

// Config is the configuration in force for one request.
type Config struct {
	Enabled  bool
	Provider string
	BaseURL  string
	Model    string
	// APIKey is the decrypted key. Never logged, never returned by any handler.
	APIKey string
	// TurnsPerMinute caps how many turns one account may start.
	TurnsPerMinute int
	// Problem explains why an otherwise-configured assistant is not usable —
	// no model, no key, a key that will not decrypt. It is written for the
	// operator's admin page and is safe to show them; it never contains the key.
	Problem string
}

// Ready reports whether a turn can be attempted.
func (c Config) Ready() bool {
	return c.Enabled && c.Problem == "" && c.Model != "" && c.APIKey != ""
}

// Endpoint is the base URL in force, with the provider's default filled in.
func (c Config) Endpoint() string {
	if c.BaseURL != "" {
		return strings.TrimRight(c.BaseURL, "/")
	}
	if c.Provider == ProviderAnthropic {
		return DefaultAnthropicBaseURL
	}
	return DefaultOpenAIBaseURL
}

// Load reads the configuration in force. It never fails: a store that cannot
// be read, a missing key or one that will not decrypt all resolve to a Config
// that is not Ready, with Problem saying which — because the caller's job is
// to tell the operator what to fix, not to return a 500.
func Load(ctx context.Context, store dbsetting.Store, box *secretbox.Box) Config {
	cfg := Config{
		Enabled:        EnabledSetting.Resolve(ctx, store),
		Provider:       ProviderSetting.Resolve(ctx, store),
		BaseURL:        BaseURLSetting.Resolve(ctx, store),
		Model:          strings.TrimSpace(ModelSetting.Resolve(ctx, store)),
		TurnsPerMinute: RateLimitSetting.Resolve(ctx, store),
	}
	key, err := readKey(ctx, store, box)
	switch {
	case err != nil:
		cfg.Problem = err.Error()
	case key == "":
		if cfg.Enabled {
			cfg.Problem = "no API key is stored for the assistant"
		}
	default:
		cfg.APIKey = key
	}
	if cfg.Problem == "" && cfg.Enabled && cfg.Model == "" {
		cfg.Problem = "no model is configured for the assistant"
	}
	return cfg
}

// readKey unseals the stored key.
//
// ⚠ A stored value that will not unseal is reported, not swallowed. It is what
// an operator sees after the encryption key changed, or after somebody wrote
// the row by hand — and "the assistant is not configured" would be a lie next
// to a settings page that visibly holds a key.
func readKey(ctx context.Context, store dbsetting.Store, box *secretbox.Box) (string, error) {
	if store == nil {
		return "", nil
	}
	sealed, err := store.GetSetting(ctx, apiKeySetting)
	if err != nil || strings.TrimSpace(sealed) == "" {
		return "", nil
	}
	if !box.Enabled() {
		return "", fmt.Errorf("an API key is stored but FILEX_SECRET_KEY is not set, so it cannot be decrypted")
	}
	key, err := box.Open(sealed)
	if err != nil {
		return "", fmt.Errorf("the stored API key cannot be decrypted (%v); re-enter it", err)
	}
	return strings.TrimSpace(key), nil
}

// StoreKey seals the key and writes it. An empty key removes the row, which is
// how an operator disconnects the provider without deleting the rest of the
// configuration.
func StoreKey(ctx context.Context, store dbsetting.Store, box *secretbox.Box, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return store.UpsertSetting(ctx, apiKeySetting, "")
	}
	if !box.Enabled() {
		// Strict on purpose, and it is secretbox's own rule: a credential that
		// reaches a third party and appears on a bill is not one to write into
		// the database in the clear because the encryption key happened to be
		// missing. The operator is told which variable to set.
		return fmt.Errorf("cannot store the assistant API key: FILEX_SECRET_KEY is not configured (%w)", secretbox.ErrNoKey)
	}
	sealed, err := box.Seal(key)
	if err != nil {
		return fmt.Errorf("seal assistant key: %w", err)
	}
	return store.UpsertSetting(ctx, apiKeySetting, sealed)
}

// HasKey reports whether a key is stored, without decrypting it. The admin
// page needs to draw "a key is set" and must not need the plaintext to do it.
func HasKey(ctx context.Context, store dbsetting.Store) bool {
	if store == nil {
		return false
	}
	sealed, err := store.GetSetting(ctx, apiKeySetting)
	return err == nil && strings.TrimSpace(sealed) != ""
}

// SeedKey writes the environment's key on first boot only, sealed — the same
// one-shot rule dbsetting applies to every other seed, so an operator who
// later changes the key in the admin page does not get it reverted by the next
// restart. A key that cannot be sealed is skipped with an error rather than
// stored in the clear.
func SeedKey(ctx context.Context, store dbsetting.Store, box *secretbox.Box) error {
	raw := strings.TrimSpace(os.Getenv(apiKeyEnv))
	if store == nil || raw == "" || HasKey(ctx, store) {
		return nil
	}
	return StoreKey(ctx, store, box, raw)
}

// SeedSettings applies the first-boot seeding for every assistant setting,
// including the key. Call once at boot, before anything resolves them.
//
// ⚠ Same one-shot contract as the rest of dbsetting: the variables provision a
// fresh install and are inert afterwards. Editing FILEX_ASSISTANT_MODEL in
// compose and restarting changes nothing once the row exists — the admin page
// owns the value from then on.
func SeedSettings(ctx context.Context, store dbsetting.Store, box *secretbox.Box) {
	if store == nil {
		return
	}
	dbsetting.SeedAll(ctx, store, Settings()...)
	if err := SeedKey(ctx, store, box); err != nil {
		slog.Warn("assistant: the API key from the environment was not stored",
			slog.String("env", apiKeyEnv), slog.Any("error", err))
	}
}
