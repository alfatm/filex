// Package assistant — title.go
//
// Naming a conversation, which is a smaller job than it looks and a more
// delicate one.
//
// A conversation list needs names: "Untitled chat" nine times is not a list.
// But the name is the ONE part of a conversation that leaves it. The operator's
// screen shows every account's conversations as metadata — titles included —
// and cannot read a single message (see handlers/assistant_admin.go). So a
// title that quotes the conversation would walk the content out through the
// one door the schema exists to keep shut.
//
// Hence a separate prompt, a separate call, and a check on the way back: the
// title says what the person WANTED, never what was found. A model that cannot
// do that is expected to say so, and a title that names a file is dropped.
package assistant

import (
	"context"
	_ "embed"
	"regexp"
	"strings"
)

//go:embed title.md
var titlePromptFile string

// titlePrompt is the whole instruction. It is not the assistant's prompt with
// a paragraph added: the two jobs share nothing, and a naming call that
// carried the file-reading rules would invite the model to go and look.
var titlePrompt = strings.TrimSpace(titlePromptFile)

// maxTitleInputRunes bounds what is sent. A pasted wall of text is still one
// question, and only its beginning says what it is about.
const maxTitleInputRunes = 500

// Title asks the model for a name for a conversation, from the person's own
// question alone.
//
// ⚠ The question, not the answer. What the person asked is what they wanted;
// the answer is where the file names are. Sending only the question makes the
// privacy rule something the call obeys by construction rather than by the
// model's goodwill.
//
// An empty return is not a failure — it means no usable name, and the
// conversation keeps the one the interface gives an unnamed one.
func (s *Service) Title(ctx context.Context, cfg Config, question string) (string, error) {
	if !cfg.Ready() {
		return "", ErrNotConfigured
	}
	provider, err := NewProvider(cfg, s.client)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	if _, err := provider.Stream(ctx, Request{
		Model:    cfg.Model,
		System:   titlePrompt,
		Messages: []Message{{Role: RoleUser, Content: clipRunes(question, maxTitleInputRunes)}},
	}, func(delta string) error {
		out.WriteString(delta)
		return nil
	}); err != nil {
		return "", err
	}
	return cleanTitle(out.String()), nil
}

// looksLikeAFile catches the two shapes the rule is really about: an address
// (`main://Reports/q1.pdf`) and a bare file name (`budget-2026.xlsx`). Both
// would put a name the operator may not see into the one field they do.
var looksLikeAFile = regexp.MustCompile(`://|/|\S+\.[A-Za-z0-9]{1,5}(\s|$)`)

// cleanTitle turns the model's answer into a name, or into nothing.
//
// Nothing is a perfectly good outcome. The list has a word for a conversation
// with no name; it has no word for one named after a file the person's
// administrator was never meant to learn about.
func cleanTitle(raw string) string {
	title := strings.TrimSpace(raw)
	// One line: a model that explained itself gets its first line taken.
	if at := strings.IndexAny(title, "\r\n"); at >= 0 {
		title = title[:at]
	}
	title = strings.TrimSpace(strings.Trim(title, "\"'`*#"))
	title = strings.TrimSuffix(title, ".")
	title = strings.Join(strings.Fields(title), " ")
	// The refusal the prompt asks for, and everything that amounts to one.
	if title == "" || title == "-" {
		return ""
	}
	// A paragraph is not a name. The model ignored the instruction, and cutting
	// it to length would leave half a sentence in the list.
	if len([]rune(title)) > maxTitleRunes {
		return ""
	}
	if looksLikeAFile.MatchString(title) {
		return ""
	}
	return title
}

// maxTitleRunes is the longest thing still worth calling a name. The interface
// clamps to its own budget as well; this one only rejects answers that are
// plainly not titles.
const maxTitleRunes = 120

// clipRunes cuts to n runes, never mid-rune.
func clipRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
