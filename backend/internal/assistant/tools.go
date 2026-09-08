// Package assistant — tools.go
//
// What the assistant can actually do, and the shape a deployment hands it in.
//
// # Why the toolbox is an interface here
//
// This package knows how to hold a conversation with a model; it knows nothing
// about storages, grants or RBAC, and it must not learn. The tools are
// implemented where the file surface already lives (handlers/assistant_tools.go)
// on top of the same ACL-checked core the MCP server uses, so a tool cannot see
// anything the person could not open themselves. This file is the seam.
//
// # A failed tool is not a failed turn
//
// Run returns no error. A folder that does not exist, a file the person has not
// approved, a search with no hits — these are all ANSWERS the model has to read
// and react to, usually by asking the person something. Turning them into
// transport errors would abort the turn and leave the person with a red line
// instead of a question they can answer.
package assistant

import "context"

// MaxToolRounds bounds one turn: how many times the model may call tools and
// look at the results before it has to answer.
//
// ⚠ This is not the same limit as assistant.turns_per_minute. That one stops a
// client from starting turns in a loop; this one stops a single turn from
// looping inside itself — the model that keeps listing the same folder waiting
// for a different answer. Reaching it ends the turn with a plain statement that
// it did, which is information the person needs.
const MaxToolRounds = 8

// ToolSpec describes one tool to the model. Schema is JSON Schema for the
// arguments, in the shape both providers accept.
type ToolSpec struct {
	Name        string
	Description string
	Schema      map[string]any
}

// ToolCall is the model asking for a tool. Args is raw JSON exactly as the
// model produced it — validating it is the tool's job, and a malformed call is
// something the tool answers rather than something this package guesses at.
type ToolCall struct {
	ID   string
	Name string
	Args string
}

// Card is something shown to the PERSON rather than to the model: today the
// one kind is an approval request, which is how a content read gets consent
// for one specific file.
type Card struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
	// Reason is why permission is being asked for, in the person's terms.
	Reason string `json:"reason"`
}

// CardApproval is the only card kind so far.
const CardApproval = "approval"

// ToolOutcome is one tool's result: what the model reads, and optionally
// something for the person to act on.
type ToolOutcome struct {
	Content string
	Card    *Card
}

// Toolbox is a deployment's set of tools.
type Toolbox interface {
	Specs() []ToolSpec
	Run(ctx context.Context, call ToolCall) ToolOutcome
}

// Event is one thing that happened during a turn, on its way to the client.
type Event struct {
	Type string
	// Text.
	Delta string
	// Tool: what is being done, so the panel can say so while it happens.
	Tool string
	Args string
	// Card.
	Card *Card
}

// Event types.
const (
	EventText = "text"
	EventTool = "tool"
	EventCard = "card"
)

// Emit receives events in the order they happen. Returning an error stops the
// turn — it is how a closed connection ends the model call.
type Emit func(Event) error

// toolNames is what the prompt's tool inventory is built from.
func toolNames(box Toolbox) []string {
	if box == nil {
		return nil
	}
	specs := box.Specs()
	out := make([]string, 0, len(specs))
	for _, spec := range specs {
		out = append(out, "- `"+spec.Name+"` — "+spec.Description)
	}
	return out
}
