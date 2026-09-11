package handlers

import "testing"

// A name that addresses a directory rather than an entry in one used to get
// past newfolder/newfile/rename: path.Join folded ".." away, the target
// resolved to the PARENT folder, and the caller was told the name was already
// taken — with, for an empty parent path, a target outside the folder it asked
// about.
func TestValidEntryName(t *testing.T) {
	for _, name := range []string{"notes", "a b", "..hidden", "...", "файл.txt", "a..b"} {
		if !validEntryName(name) {
			t.Errorf("validEntryName(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"", ".", "..", "a/b", "a\\b", "/", "../x"} {
		if validEntryName(name) {
			t.Errorf("validEntryName(%q) = true, want false", name)
		}
	}
}
