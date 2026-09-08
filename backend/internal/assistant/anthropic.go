// Package assistant — anthropic.go
//
// The Anthropic Messages protocol: POST /messages with `stream: true`,
// answered as named server-sent events. Four differences from the
// openai-compatible shape drive everything in this file: the key travels in
// x-api-key rather than Authorization, the API version is pinned by a header,
// the system prompt is its own field instead of a message with role "system",
// and a message's content is a LIST OF BLOCKS — which is where tool calls and
// their results live, rather than in fields beside the text.
package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// anthropicVersion is the API version this client is written against. It is
// pinned rather than tracked: Anthropic keeps old versions working, and a
// client that silently followed the newest one would change behaviour on their
// release schedule instead of ours.
const anthropicVersion = "2023-06-01"

type anthropicProvider struct {
	endpoint string
	key      string
	client   *http.Client
}

func (p *anthropicProvider) Name() string { return ProviderAnthropic }

type anthropicMessage struct {
	Role string `json:"role"`
	// Content is a string for a plain turn and a block list once tool calls or
	// their results are involved.
	Content any `json:"content"`
}

type anthropicTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
}

type anthropicRequest struct {
	Model     string             `json:"model"`
	System    string             `json:"system,omitempty"`
	MaxTokens int                `json:"max_tokens"`
	Stream    bool               `json:"stream"`
	Messages  []anthropicMessage `json:"messages"`
	Tools     []anthropicTool    `json:"tools,omitempty"`
}

type anthropicEvent struct {
	Index        int `json:"index"`
	ContentBlock struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"content_block"`
	Delta struct {
		Text        string `json:"text"`
		PartialJSON string `json:"partial_json"`
	} `json:"delta"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Stream sends the conversation and emits each text delta.
func (p *anthropicProvider) Stream(ctx context.Context, req Request, onText func(string) error) ([]ToolCall, error) {
	body, err := json.Marshal(anthropicRequest{
		Model:     req.Model,
		System:    req.System,
		MaxTokens: MaxOutputTokens,
		Stream:    true,
		Messages:  anthropicMessages(req.Messages),
		Tools:     anthropicTools(req.Tools),
	})
	if err != nil {
		return nil, fmt.Errorf("assistant: encode request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/messages", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("assistant: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("x-api-key", p.key)
	httpReq.Header.Set("anthropic-version", anthropicVersion)

	pending := map[int]*ToolCall{}
	err = runStream(ctx, p.client, httpReq, func(name, data string) error {
		var ev anthropicEvent
		decoded := json.Unmarshal([]byte(data), &ev) == nil
		switch name {
		case "content_block_start":
			if decoded && ev.ContentBlock.Type == "tool_use" {
				pending[ev.Index] = &ToolCall{ID: ev.ContentBlock.ID, Name: ev.ContentBlock.Name}
			}
		case "content_block_delta":
			if !decoded {
				return nil
			}
			// One event type carries both: text for the answer, JSON fragments
			// for a tool call's arguments, told apart by which block they
			// belong to.
			if call := pending[ev.Index]; call != nil {
				call.Args += ev.Delta.PartialJSON
				return nil
			}
			if ev.Delta.Text == "" {
				return nil
			}
			return onText(ev.Delta.Text)
		case "error":
			if decoded && ev.Error != nil {
				return fmt.Errorf("assistant: provider error: %s", ev.Error.Message)
			}
			return fmt.Errorf("assistant: provider error")
		case "message_stop":
			return errStop
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return collectCalls(pending), nil
}

// anthropicMessages renders the conversation as this protocol wants it.
//
// ⚠⚠ Two rules here are requirements, not style. A tool RESULT is a user turn
// carrying tool_result blocks — there is no "tool" role — and consecutive
// results must be merged into ONE user message, because the API refuses a
// conversation whose turns do not alternate. A loop that ran three tools would
// otherwise send three user messages in a row and be rejected outright.
func anthropicMessages(messages []Message) []anthropicMessage {
	out := make([]anthropicMessage, 0, len(messages))
	for _, m := range messages {
		switch {
		case m.Role == RoleTool:
			block := map[string]any{"type": "tool_result", "tool_use_id": m.ToolCallID, "content": m.Content}
			if n := len(out); n > 0 && out[n-1].Role == RoleUser {
				if blocks, ok := out[n-1].Content.([]any); ok {
					out[n-1].Content = append(blocks, block)
					continue
				}
			}
			out = append(out, anthropicMessage{Role: RoleUser, Content: []any{block}})
		case len(m.ToolCalls) > 0:
			blocks := []any{}
			if m.Content != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
			}
			for _, call := range m.ToolCalls {
				// Arguments travel as an object, not as the string the wire
				// delivered them in; an unparseable one is sent as empty rather
				// than as text the API would refuse.
				var input any = map[string]any{}
				if call.Args != "" {
					_ = json.Unmarshal([]byte(call.Args), &input)
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": call.ID, "name": call.Name, "input": input})
			}
			out = append(out, anthropicMessage{Role: RoleAssistant, Content: blocks})
		default:
			out = append(out, anthropicMessage{Role: m.Role, Content: m.Content})
		}
	}
	return out
}

func anthropicTools(specs []ToolSpec) []anthropicTool {
	if len(specs) == 0 {
		return nil
	}
	out := make([]anthropicTool, 0, len(specs))
	for _, spec := range specs {
		out = append(out, anthropicTool{Name: spec.Name, Description: spec.Description, InputSchema: spec.Schema})
	}
	return out
}
