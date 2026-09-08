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

// Message is one turn of conversation, in the provider-neutral form.
type Message struct {
	Role    string
	Content string
	// ToolCalls are what an assistant turn asked for. Present only on
	// RoleAssistant.
	ToolCalls []ToolCall
	// ToolCallID names the call a RoleTool message answers.
	ToolCallID string
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

// checkStatus turns a non-2xx response into an error a person can act on. The
// provider's own message is the useful part ("model not found", "insufficient
// quota"), so it is quoted rather than replaced with a generic failure.
func checkStatus(resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	detail := strings.TrimSpace(string(body))
	if detail == "" {
		return fmt.Errorf("assistant: provider returned %s", resp.Status)
	}
	return fmt.Errorf("assistant: provider returned %s: %s", resp.Status, detail)
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

// runStream performs the request and scans the response, mapping the two
// endings that are not failures: the provider's own terminator (errStop) and
// the caller's cancellation.
func runStream(ctx context.Context, client *http.Client, req *http.Request, handle func(event, data string) error) error {
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("assistant: %w", err)
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return err
	}
	err = scanSSE(resp.Body, handle)
	switch {
	case errors.Is(err, errStop):
		return nil
	case ctx.Err() != nil:
		return nil
	}
	return err
}
