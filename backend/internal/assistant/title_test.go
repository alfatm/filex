package assistant

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestTitlePrompt_CarriesTheRulesItMustCarry(t *testing.T) {
	for _, required := range []string{
		"NOT private",
		"never a file name",
		"never anything quoted or paraphrased",
		"a single hyphen",
	} {
		assert.Contains(t, titlePrompt, required, "the naming prompt lost: %s", required)
	}
	// It is the naming job and nothing else: a prompt that also carried the
	// file rules would be telling this call it may go and look at files.
	assert.NotContains(t, titlePrompt, "list_folder")
}

func TestCleanTitle(t *testing.T) {
	for _, c := range []struct {
		name, raw, want string
	}{
		{"a plain name", "Looking for last quarter's report", "Looking for last quarter's report"},
		{"quoted, as models like to", `"Finding the design files"`, "Finding the design files"},
		{"with a full stop and markdown", "**Sorting the photos.**", "Sorting the photos"},
		{"a model that explained itself", "Sorting the photos\nI chose this because…", "Sorting the photos"},
		{"the refusal the prompt asks for", "-", ""},
		{"nothing at all", "   ", ""},
		// ⚠ These four are the point of the whole file.
		{"an address", "Reading main://HR/salaries.xlsx", ""},
		{"a bare file name", "Opening budget-2026-final.xlsx", ""},
		{"a path", "Looking in HR/2026/salaries", ""},
		{"a paragraph, not a name", "This conversation is about the person's attempt to locate a particular quarterly report which they believed to be somewhere in the shared drive", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			assert.Equal(t, c.want, cleanTitle(c.raw))
		})
	}
}

// A wall of pasted text is still one question, and only its beginning says
// what it is about.
func TestClipRunes_CutsOnRunesNotBytes(t *testing.T) {
	assert.Equal(t, "привет", clipRunes("привет мир", 6))
	assert.Equal(t, "short", clipRunes("short", 50))
}
