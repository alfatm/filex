// Package assistant — prompt.go
//
// The standing instructions the model answers under.
//
// # Why so much of it is about not doing things
//
// The rules here were written by the owner of the data, and they are ranked:
// the safety of the files comes first, ahead of being useful. That ordering is
// deliberate and it is the one thing in this file that must not be softened to
// make the assistant feel more capable. The reason is stated in the prompt
// itself and is worth repeating here: THERE IS NO SAFETY NET. A database
// backup is a snapshot of the metadata, and file versioning only covers files
// that were overwritten in place, by a path that snapshots — neither brings
// back a subtree the assistant moved somewhere nobody can name or deleted for
// good. So the prompt is written for an actor with no undo.
//
// # Where the text lives
//
// In prompt.md and prompt_no_tools.md beside this file (and title.md, which
// belongs to title.go), embedded at build time — NOT in a file the running
// server reads. The instructions are part of the binary
// for the same reason the tool set is: an operator who could edit them at
// runtime could edit away the approval gate's wording, and a deployment could
// then differ from what its tests pin. Editing one means a rebuild, which is
// the point.
//
// ⚠ //go:embed cannot fill a const, so these are vars. Nothing outside this
// package can reach them; that is as close to a constant as the mechanism gets.
//
// # A prompt is not an enforcement mechanism
//
// None of this is security. A model can be talked out of any instruction, and
// everything here that MATTERS is also enforced in code: the approval gate,
// the per-file consent for content, the operations that do not exist as tools
// at all. The prompt exists so the assistant behaves well in the ordinary case
// and asks in the doubtful one — not so that a determined prompt injection is
// stopped by a paragraph. Where the two disagree, the code wins, and anything
// added here that has no counterpart in code should be read as guidance only.
package assistant

import (
	_ "embed"
	"strconv"
	"strings"
)

// MaxFilesPerListing is the ceiling the prompt states and the tools enforce:
// one listing call never returns more than this many entries.
const MaxFilesPerListing = 1000

// maxFilesPlaceholder is what prompt.md writes where that number goes.
//
// ⚠ A NAME, not %d. The text is prose that people edit, and one "%" typed
// anywhere in it would turn a Sprintf into "%!s(MISSING)" inside the model's
// instructions — a corruption nothing would report.
const maxFilesPlaceholder = "{max_files}"

//go:embed prompt.md
var systemPromptFile string

//go:embed prompt_no_tools.md
var noToolsFile string

// systemPrompt is the standing instruction set: English, by the owner's
// choice, regardless of the language the conversation is held in.
var systemPrompt = strings.ReplaceAll(strings.TrimSpace(systemPromptFile), maxFilesPlaceholder, strconv.Itoa(MaxFilesPerListing))

// noToolsNotice is appended while the deployment has registered no tools. It
// is not padding: a model told at length how to read files carefully, and then
// given nothing to read them with, invents plausible file listings unless it
// is told plainly that it cannot see anything.
var noToolsNotice = strings.TrimSpace(noToolsFile)

// SystemPrompt returns the standing instructions, with an inventory of the
// tools the deployment actually registered. Passing the real list is what
// keeps the prompt honest as the tool set grows stage by stage.
func SystemPrompt(tools []string) string {
	if len(tools) == 0 {
		return systemPrompt + "\n\n" + noToolsNotice
	}
	return systemPrompt + "\n\n# Your tools\n\n" + strings.Join(tools, "\n")
}
