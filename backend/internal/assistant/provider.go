// Package assistant — provider.go
//
// The model call, reduced to the one shape this application needs: send a
// conversation, receive text as it is produced, stop when the caller's context
// is cancelled.
//
// # Why the interface is this small
//
// Two providers are supported and one is configured at a time, so this is not
// an abstraction over "all LLM APIs" — it is the seam between filex and
// whichever of the two an operator picked. Everything the two disagree about
// (auth header, request shape, event names) lives in its own file; everything
// they agree about (server-sent events, one text stream, cancellation) lives
// here.
package assistant

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// MaxOutputTokens bounds one answer. Anthropic requires the field; OpenAI
// treats it as a ceiling. It is a constant rather than a setting because it is
// not an operator's decision — it is the size of a side panel.
const MaxOutputTokens = 4096

// maxErrorBody is how much of a provider's error response is quoted back. Long
// enough to carry "model not found" or "invalid api key", short enough that a
// provider returning an HTML error page does not fill the log.
const maxErrorBody = 512

// Roles a Message can carry.
const (
	RoleUser      = "user"
	RoleAssistant = "assistant"
	// RoleTool is one tool's result on its way back to the model. It always
	// carries the ToolCallID of the call it answers — both providers match
	// results to calls by id, not by position.
	RoleTool = "tool"
)

// Image is a picture a tool result shows the model, as bytes the model's
// protocol will carry base64-encoded. Only RoleTool messages carry them.
type Image struct {
	Mime string
	Data []byte
}

// Message is one turn of conversation, in the provider-neutral form.
type Message struct {
	Role    string
	Content string
	// ToolCalls are what an assistant turn asked for. Present only on
	// RoleAssistant.
	ToolCalls []ToolCall
	// ToolCallID names the call a RoleTool message answers.
	ToolCallID string
	// Images are what the tool result SHOWS, beside what it says. Each
	// protocol carries them where it allows a picture: Anthropic inside the
	// tool_result block, the openai-compatible dialect in a user turn right
	// after the result, since its tool role takes text only.
	Images []Image
}

// Request is one model call.
type Request struct {
	Model    string
	System   string
	Messages []Message
	// Tools the model may call. Empty means it may only talk.
	Tools []ToolSpec
}

// Provider streams an answer. onText is called with each piece of text as it
// arrives, in order; returning an error from it stops the stream.
//
// The return value is the tool calls the model asked for, if any. They come
// back at the END rather than through the callback because a tool call is only
// usable once its arguments are complete, and both protocols deliver those in
// fragments.
//
// A cancelled context ends the stream without an error of its own — stopping
// is something the user does on purpose, not a failure.
type Provider interface {
	Stream(ctx context.Context, req Request, onText func(string) error) ([]ToolCall, error)
	// Name is what the admin page shows and what the logs say.
	Name() string
}

// NewProvider builds the configured provider. It does not dial anything.
func NewProvider(cfg Config, client *http.Client) (Provider, error) {
	if client == nil {
		client = http.DefaultClient
	}
	switch cfg.Provider {
	case ProviderAnthropic:
		return &anthropicProvider{endpoint: cfg.Endpoint(), key: cfg.APIKey, client: client}, nil
	case ProviderOpenAI, "":
		return &openAIProvider{endpoint: cfg.Endpoint(), key: cfg.APIKey, client: client}, nil
	}
	return nil, fmt.Errorf("unknown assistant provider %q", cfg.Provider)
}

// errStop ends the scan from inside a handler without being an error the
// caller sees — the provider said the answer is complete.
var errStop = errors.New("assistant: end of stream")

// ProviderError is a non-2xx answer from the model provider, with the status
// kept beside the quoted body so a handler can tell the person WHICH kind of
// failure it was rather than only that one happened.
type ProviderError struct {
	Status int
	Detail string
}

func (e *ProviderError) Error() string {
	if e.Detail == "" {
		return fmt.Sprintf("assistant: provider returned %d", e.Status)
	}
	return fmt.Sprintf("assistant: provider returned %d: %s", e.Status, e.Detail)
}

// checkStatus turns a non-2xx response into an error a person can act on. The
// provider's own message is the useful part ("model not found", "insufficient
// quota"), so it is quoted rather than replaced with a generic failure.
func checkStatus(resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	return &ProviderError{Status: resp.StatusCode, Detail: strings.TrimSpace(string(body))}
}

// The two failures a person can do something about — and neither is "try
// again". They travel on the turn's error event as `code`; anything else is
// a generic failure and carries none.
const (
	// ErrorCodeQuota: the provider account is out of credit. An administrator
	// has to top it up; retrying only produces the same answer.
	ErrorCodeQuota = "quota"
	// ErrorCodeUnavailable: the assistant cannot answer at all any more — it
	// was switched off, its key was revoked, or the model is gone.
	ErrorCodeUnavailable = "unavailable"
)

// quotaMarkers are the spellings that mean "out of credit" whatever the status
// carrying them: OpenAI's error code, which arrives on 429 — the same status as
// a rate limit, which is why the body is read and not only the status — and
// Anthropic's message, which arrives on 400.
var quotaMarkers = []string{"insufficient_quota", "credit balance"}

// billingWords are words that mean "out of credit" only on a status that is
// already a refusal to serve this account at all. On their own they are
// ambiguous: "Quota exceeded for requests per minute" is how the Google- and
// Azure-compatible gateways spell an ordinary rate limit, and telling that
// person an administrator has to top up an account sends them to the wrong
// place — waiting a minute is the whole fix.
var billingWords = []string{"billing", "quota"}

// ErrorCode classifies a failed turn for the person. "" is the ordinary
// failure: a provider hiccup, a network error, a malformed stream.
func ErrorCode(err error) string {
	if errors.Is(err, ErrNotConfigured) {
		return ErrorCodeUnavailable
	}
	var pe *ProviderError
	if !errors.As(err, &pe) {
		return ""
	}
	detail := strings.ToLower(pe.Detail)
	if containsAny(detail, quotaMarkers) {
		return ErrorCodeQuota
	}
	switch pe.Status {
	case http.StatusPaymentRequired:
		return ErrorCodeQuota
	case http.StatusForbidden:
		// A refusal that names the account's money is an account out of credit
		// rather than a key that lost its access.
		if containsAny(detail, billingWords) {
			return ErrorCodeQuota
		}
		return ErrorCodeUnavailable
	case http.StatusUnauthorized, http.StatusNotFound:
		return ErrorCodeUnavailable
	}
	return ""
}

func containsAny(haystack string, words []string) bool {
	for _, word := range words {
		if strings.Contains(haystack, word) {
			return true
		}
	}
	return false
}

// scanSSE reads a server-sent event stream and calls handle for each event.
//
// It is deliberately lenient about the parts of the SSE grammar neither
// provider uses (multi-line data, retry, id) and strict about the one thing
// that matters: an event is dispatched at a blank line, with the event name
// that preceded it, so a `data:` line is never handed over under the wrong
// name.
func scanSSE(r io.Reader, handle func(event, data string) error) error {
	scanner := bufio.NewScanner(r)
	// Provider payloads are small, but a long answer's delta plus JSON overhead
	// can exceed bufio's 64 KiB default, and a torn line would be parsed as
	// malformed rather than as "too long".
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	event, data := "", ""
	flush := func() error {
		if data == "" {
			event = ""
			return nil
		}
		err := handle(event, data)
		event, data = "", ""
		return err
	}
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		switch {
		case line == "":
			if err := flush(); err != nil {
				return err
			}
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	// A stream that ends without a trailing blank line still has an event.
	return flush()
}

// headWriter keeps the first maxErrorBody bytes written through it and drops
// the rest. It rides along the response body so a 2xx answer that turns out not
// to be a stream at all can still be quoted back, without ever holding a long
// answer in memory.
type headWriter struct{ head []byte }

func (h *headWriter) Write(p []byte) (int, error) {
	if room := maxErrorBody - len(h.head); room > 0 {
		h.head = append(h.head, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

// contextEnding says how a failed call ends given the caller's context, and
// whether the context decides it at all.
//
// ⚠ The two ways a context dies mean opposite things here and are identical to
// look at unless they are told apart. A CANCELLED context is the stop button —
// the person's own decision, not a failure. An EXPIRED DEADLINE is a provider
// that never answered, and somebody has to be told: the admin page's Test
// button hangs its own 30-second deadline on the call and used to report a
// hung provider as "the model replied with nothing".
func contextEnding(ctx context.Context) (bool, error) {
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		return true, nil
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return true, fmt.Errorf("assistant: the provider did not answer within the time allowed: %w", ctx.Err())
	}
	return false, nil
}

// notAStream is what a 2xx answer with no event in it is reported as.
const notAStream = "the answer was not an event stream: "

// runStream performs the request and scans the response, mapping the endings
// that are not failures: the provider's own terminator (errStop) and the
// caller's cancellation.
//
// ⚠ A 2xx that yielded no event is a FAILURE, not an empty answer. Gateways
// that ignore `stream: true` reply with one JSON object, and proxies in front
// of them answer `200 {"error":…}`; both used to end the turn with no text, no
// stored answer and nothing in the log — an empty bubble the person could only
// read as the model having nothing to say.
func runStream(ctx context.Context, client *http.Client, req *http.Request, handle func(event, data string) error) error {
	resp, err := client.Do(req)
	if err != nil {
		if decided, ending := contextEnding(ctx); decided {
			return ending
		}
		return fmt.Errorf("assistant: %w", err)
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return err
	}
	var head headWriter
	frames := 0
	err = scanSSE(io.TeeReader(resp.Body, &head), func(event, data string) error {
		frames++
		return handle(event, data)
	})
	switch {
	case errors.Is(err, errStop):
		return nil
	case err == nil && frames > 0:
		return nil
	}
	if decided, ending := contextEnding(ctx); decided {
		return ending
	}
	if err != nil {
		return err
	}
	return &ProviderError{Status: resp.StatusCode, Detail: notAStream + strings.TrimSpace(string(head.head))}
}
