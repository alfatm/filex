// Package assistant — service.go
//
// What a handler holds: the configuration in force, the provider built from
// it, and the two limits that stop one account from running away with the
// installation.
//
// # The limits, and what each is actually for
//
//   - ONE turn at a time per account. This is not throttling — it is what
//     makes "stop" mean something. A second turn started while the first is
//     streaming would write two answers into one conversation, interleaved,
//     and neither would be the one the person is reading.
//   - N turns per minute per account (assistant.turns_per_minute). This is the
//     loop-breaker. An agent that has talked itself into a circle re-asks at
//     the speed of the network; a person types. The ceiling is set where no
//     human reaches it and no loop survives it.
//
// Neither is a cost control. Metering spend is a different problem with a
// different owner and is deliberately out of scope here.
package assistant

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/brf-tech/filex/backend/internal/dbsetting"
	"github.com/brf-tech/filex/backend/internal/secretbox"
)

// MaxHistoryMessages is how much of a conversation is replayed to the model.
// The whole history would grow without bound, and a hundred-turn conversation
// costs more to send than it adds: the recent turns are the context, the old
// ones are the archive the person can still read on screen.
const MaxHistoryMessages = 40

// requestTimeout bounds one model call. Long enough for a slow model to think,
// short enough that a hung connection does not hold a session open forever.
const requestTimeout = 5 * time.Minute

// Errors a handler maps to a status code.
var (
	// ErrNotConfigured means no usable provider — the handler answers 503 and
	// the panel is not offered in the first place.
	ErrNotConfigured = errors.New("assistant: not configured")
	// ErrBusy means this account already has a turn in flight.
	ErrBusy = errors.New("assistant: a turn is already running")
	// ErrRateLimited means the per-minute ceiling was reached.
	ErrRateLimited = errors.New("assistant: too many turns")
)

// Service is the assistant's model side. Safe for concurrent use.
type Service struct {
	store  dbsetting.Store
	box    *secretbox.Box
	client *http.Client

	mu     sync.Mutex
	active map[int64]bool
	starts map[int64][]time.Time
}

// New constructs the service. The store is where the configuration lives and
// box is what unseals the key; both may be nil in tests that only exercise the
// limits.
func New(store dbsetting.Store, box *secretbox.Box) *Service {
	return &Service{
		store:  store,
		box:    box,
		client: &http.Client{Timeout: requestTimeout, CheckRedirect: refuseOffHostRedirect},
		active: map[int64]bool{},
		starts: map[int64][]time.Time{},
	}
}

// maxRedirects is the same ceiling net/http applies by default.
const maxRedirects = 10

// refuseOffHostRedirect keeps the key on the origin it was configured for. Go
// drops Authorization when a redirect leaves the host, but not x-api-key, so
// following one would hand the Anthropic header to whatever the provider
// points at. A provider that moves announces it; it does not redirect.
//
// ⚠ The SCHEME is part of the comparison, not only the host. Go's own
// same-host rule is what strips Authorization, and it says nothing about
// https→http: a response redirecting to the very same host over plain HTTP
// passed a host-only check and put the key on the wire in clear text.
func refuseOffHostRedirect(req *http.Request, via []*http.Request) error {
	if req.URL.Host != via[0].URL.Host || req.URL.Scheme != via[0].URL.Scheme {
		return fmt.Errorf("assistant: provider redirected to %s://%s; not following a redirect off the configured origin", req.URL.Scheme, req.URL.Host)
	}
	if len(via) >= maxRedirects {
		return fmt.Errorf("assistant: stopped after %d redirects", maxRedirects)
	}
	return nil
}

// Config reads the configuration in force. Cheap enough to call per request —
// it is four settings rows — and read per request on purpose, so an operator's
// change takes effect on the next question rather than the next restart.
func (s *Service) Config(ctx context.Context) Config {
	return Load(ctx, s.store, s.box)
}

// Begin claims the account's turn slot. The returned release must be called
// when the turn ends, however it ends.
func (s *Service) Begin(userID int64, turnsPerMinute int) (func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active[userID] {
		return nil, ErrBusy
	}
	now := time.Now()
	recent := s.starts[userID][:0]
	for _, at := range s.starts[userID] {
		if now.Sub(at) < time.Minute {
			recent = append(recent, at)
		}
	}
	if turnsPerMinute > 0 && len(recent) >= turnsPerMinute {
		s.starts[userID] = recent
		return nil, ErrRateLimited
	}
	s.starts[userID] = append(recent, now)
	s.active[userID] = true
	return func() {
		s.mu.Lock()
		delete(s.active, userID)
		s.mu.Unlock()
	}, nil
}

// Ask runs one turn: the model answers, and while it asks for tools instead,
// they are run and their results handed back until it does answer.
//
// history is the conversation so far, oldest first, with the new question as
// its last entry. box may be nil — a deployment with no tools, where the model
// can only talk.
func (s *Service) Ask(ctx context.Context, cfg Config, box Toolbox, history []Message, emit Emit) error {
	if !cfg.Ready() {
		return ErrNotConfigured
	}
	provider, err := NewProvider(cfg, s.client)
	if err != nil {
		return err
	}
	req := Request{
		Model:  cfg.Model,
		System: SystemPrompt(toolNames(box)),
		// ⚠ Trimmed ONCE, here. What the loop appends below is a tool
		// conversation — an assistant turn holding calls, then one result per
		// call — and trimHistory's merging of same-role neighbours would fuse
		// those into text neither provider could match back to its call.
		Messages: trimHistory(history),
	}
	if box != nil {
		req.Tools = box.Specs()
	}
	for round := 0; ; round++ {
		var answer strings.Builder
		calls, err := provider.Stream(ctx, req, func(delta string) error {
			answer.WriteString(delta)
			return emit(Event{Type: EventText, Delta: delta})
		})
		if err != nil {
			return err
		}
		if len(calls) == 0 || box == nil {
			return nil
		}
		if round+1 >= MaxToolRounds {
			// Said out loud rather than logged. A turn that stopped because it
			// went round in circles looks exactly like one that finished, and
			// the person is the only one who can break the circle.
			return emit(Event{Type: EventText, Delta: roundLimitNotice})
		}
		req.Messages = append(req.Messages, Message{Role: RoleAssistant, Content: answer.String(), ToolCalls: calls})
		for _, call := range calls {
			if err := emit(Event{Type: EventTool, Tool: call.Name, Args: call.Args}); err != nil {
				return err
			}
			outcome := box.Run(ctx, call)
			if outcome.Card != nil {
				if err := emit(Event{Type: EventCard, Card: outcome.Card}); err != nil {
					return err
				}
			}
			// What the tool found, for the person, before the model has said a
			// word about it. The model reads the same result as text; this is
			// the same thing to look at.
			if len(outcome.Hits) > 0 {
				if err := emit(Event{Type: EventHits, Hits: outcome.Hits}); err != nil {
					return err
				}
			}
			if len(outcome.Report) > 0 {
				if err := emit(Event{Type: EventReport, Report: outcome.Report}); err != nil {
					return err
				}
			}
			req.Messages = append(req.Messages, Message{Role: RoleTool, ToolCallID: call.ID, Content: outcome.Content, Images: outcome.Images})
		}
	}
}

// systemNotePrefix marks the executor's line so the model does not read it as
// something the person typed. Short on purpose: it is prepended to every such
// note and the note itself already says who did what.
const systemNotePrefix = "[system] "

// roundLimitNotice is what a turn that hit MaxToolRounds ends with.
const roundLimitNotice = "\n\n_I stopped after looking at too many things in a row without reaching an answer. Ask me again with something narrower — a folder, or a name to look for._"

// trimHistory prepares the conversation for a provider.
//
// Three things happen here, and each is a real provider requirement rather
// than tidiness: empty turns are dropped (an aborted answer can leave one),
// consecutive same-role turns are merged (Anthropic refuses a conversation
// that does not alternate, which is exactly what an aborted turn produces),
// and the result is cut to the most recent MaxHistoryMessages, starting at a
// user turn.
func trimHistory(history []Message) []Message {
	merged := make([]Message, 0, len(history))
	for _, m := range history {
		if strings.TrimSpace(m.Content) == "" {
			continue
		}
		// The executor's line, handed over as a user turn that names itself —
		// see RoleSystem. It is done here, before the merge below, so a note
		// followed by a question reaches the model as one user turn rather
		// than as two the providers would have to alternate around.
		if m.Role == RoleSystem {
			m.Role, m.Content = RoleUser, systemNotePrefix+m.Content
		}
		if n := len(merged); n > 0 && merged[n-1].Role == m.Role {
			merged[n-1].Content += "\n\n" + m.Content
			continue
		}
		merged = append(merged, m)
	}
	if len(merged) > MaxHistoryMessages {
		merged = merged[len(merged)-MaxHistoryMessages:]
	}
	// A conversation that starts with an assistant turn is one the window cut
	// in half; the reply without its question is noise to the model.
	if len(merged) > 0 && merged[0].Role != "user" {
		merged = merged[1:]
	}
	return merged
}
