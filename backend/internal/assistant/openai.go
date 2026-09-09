// Package assistant — openai.go
//
// The openai-compatible wire protocol: POST /chat/completions with
// `stream: true`, answered as server-sent events whose data is a chunk object.
//
// ⚠ This provider is the protocol, not the vendor. vLLM, Ollama, LiteLLM and
// most self-hosted gateways speak it, which is exactly why an operator running
// a model on their own hardware selects "openai" and points base_url at it.
// Nothing here may depend on behaviour only api.openai.com has.
package assistant

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
)

type openAIProvider struct {
	endpoint string
	key      string
	client   *http.Client
}

func (p *openAIProvider) Name() string { return ProviderOpenAI }

type openAIToolCall struct {
	ID       string `json:"id,omitempty"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openAIMessage struct {
	Role string `json:"role"`
	// Content is a string, or — on the user turn that carries a tool result's
	// picture — a list of parts.
	Content   any              `json:"content"`
	ToolCalls []openAIToolCall `json:"tool_calls,omitempty"`
	// ToolCallID is set on a tool result and matches the call it answers.
	ToolCallID string `json:"tool_call_id,omitempty"`
}

type openAITool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

type openAIRequest struct {
	Model    string          `json:"model"`
	Stream   bool            `json:"stream"`
	Messages []openAIMessage `json:"messages"`
	Tools    []openAITool    `json:"tools,omitempty"`
}

// openAIChunk is the slice of the chunk object this application reads. The
// rest (usage, logprobs, finish_reason) is ignored on purpose: the stream ends
// at the [DONE] terminator or at the response body's end, and inferring an
// ending from finish_reason would differ between servers.
type openAIChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// openAIMessages renders the conversation as this protocol wants it.
//
// A tool result's picture cannot ride on the tool message — this dialect's
// tool role takes text only — so it follows as a user turn of parts, right
// after the result it belongs to, which every openai-compatible server that
// sees images at all accepts.
func openAIMessages(req Request) []openAIMessage {
	messages := make([]openAIMessage, 0, len(req.Messages)+1)
	if req.System != "" {
		messages = append(messages, openAIMessage{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		out := openAIMessage{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID}
		for _, call := range m.ToolCalls {
			one := openAIToolCall{ID: call.ID, Type: "function"}
			one.Function.Name = call.Name
			one.Function.Arguments = call.Args
			out.ToolCalls = append(out.ToolCalls, one)
		}
		messages = append(messages, out)
		if m.Role != RoleTool || len(m.Images) == 0 {
			continue
		}
		parts := []any{map[string]any{"type": "text", "text": "The image returned by tool call " + m.ToolCallID + ":"}}
		for _, img := range m.Images {
			url := "data:" + img.Mime + ";base64," + base64.StdEncoding.EncodeToString(img.Data)
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}})
		}
		messages = append(messages, openAIMessage{Role: RoleUser, Content: parts})
	}
	return messages
}

// Stream sends the conversation and emits each text delta.
//
// ⚠ No max_tokens is sent. The field is spelled differently across current
// OpenAI models (max_tokens vs max_completion_tokens) and several servers
// reject the one they do not know, which would turn a working deployment into
// a 400 on the first question. The answer length is bounded by the model's own
// default and by the panel it is read in.
func (p *openAIProvider) Stream(ctx context.Context, req Request, onText func(string) error) ([]ToolCall, error) {
	body, err := json.Marshal(openAIRequest{
		Model: req.Model, Stream: true, Messages: openAIMessages(req), Tools: openAITools(req.Tools),
	})
	if err != nil {
		return nil, fmt.Errorf("assistant: encode request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("assistant: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Authorization", "Bearer "+p.key)

	// Tool calls arrive in fragments keyed by index: the id and name once, the
	// arguments a few characters at a time.
	pending := map[int]*ToolCall{}
	err = runStream(ctx, p.client, httpReq, func(_, data string) error {
		if data == "[DONE]" {
			return errStop
		}
		var chunk openAIChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			// A frame this client cannot read is skipped rather than failing
			// the answer: servers add fields, and a keep-alive comment or a
			// vendor extension must not throw away text already delivered.
			return nil
		}
		if chunk.Error != nil {
			return fmt.Errorf("assistant: provider error: %s", chunk.Error.Message)
		}
		for _, choice := range chunk.Choices {
			for _, frag := range choice.Delta.ToolCalls {
				call := pending[frag.Index]
				if call == nil {
					call = &ToolCall{}
					pending[frag.Index] = call
				}
				if frag.ID != "" {
					call.ID = frag.ID
				}
				if frag.Function.Name != "" {
					call.Name = frag.Function.Name
				}
				call.Args += frag.Function.Arguments
			}
			if choice.Delta.Content == "" {
				continue
			}
			if err := onText(choice.Delta.Content); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return collectCalls(pending), nil
}

// openAITools renders the tool specs in the shape the protocol expects.
func openAITools(specs []ToolSpec) []openAITool {
	if len(specs) == 0 {
		return nil
	}
	out := make([]openAITool, 0, len(specs))
	for _, spec := range specs {
		one := openAITool{Type: "function"}
		one.Function.Name = spec.Name
		one.Function.Description = spec.Description
		one.Function.Parameters = spec.Schema
		out = append(out, one)
	}
	return out
}

// collectCalls flattens the index-keyed accumulator, in index order — the order
// the model asked for them, which is the order they are run in.
func collectCalls(pending map[int]*ToolCall) []ToolCall {
	if len(pending) == 0 {
		return nil
	}
	indexes := make([]int, 0, len(pending))
	for index := range pending {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	out := make([]ToolCall, 0, len(indexes))
	for _, index := range indexes {
		if call := pending[index]; call.Name != "" {
			out = append(out, *call)
		}
	}
	return out
}
