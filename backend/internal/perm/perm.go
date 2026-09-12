// Package perm answers one question: "may an account with THIS role do THIS
// kind of thing at all?"
//
// It is a second, coarser gate that sits beside the per-item ACL
// (internal/acl), never instead of it. The ACL answers "may this person touch
// THIS file"; perm answers "is this person allowed to delete anything, ever".
// Both must say yes. An operator who takes `files.delete` away from the `user`
// role has not changed a single grant — every editor grant still reads and
// writes as before, and the delete button simply stops working for that role.
//
// The vocabulary lives here rather than in the DB because the set of
// operations is fixed by the code that enforces them: a row naming an
// operation no handler checks would be a permission that silently does
// nothing, which is the worst thing a permissions screen can contain.
// roles.permissions_json (migration 00044) stores only which of THESE an
// installation has switched on.
package perm

// Operation identifiers. These are the values stored in
// roles.permissions_json and the values a 403 reports back in its `op` field.
const (
	// OpUpload — write new bytes: the staged upload protocol, the multipart
	// upload verb, "new file", and the text editor's save.
	OpUpload = "files.upload"
	// OpMkdir — create a folder.
	OpMkdir = "files.mkdir"
	// OpRename — rename in place.
	OpRename = "files.rename"
	// OpMove — move to another folder or storage.
	OpMove = "files.move"
	// OpCopy — duplicate to another location.
	OpCopy = "files.copy"
	// OpDelete — send to the trash. Recoverable; OpPurge is the one that is not.
	OpDelete = "files.delete"
	// OpPurge — delete forever: purging one trashed item, or emptying the trash.
	OpPurge = "files.purge"
	// OpRestore — bring something back: out of the trash, or a file to an
	// older version. One operation because both are the same act from the
	// account holder's side — undoing a change they no longer want.
	OpRestore = "files.restore"
	// OpDownload — take the bytes away (single file, or a folder as a zip).
	//
	// ⚠ NOT previewing. Preview and thumbnails stay open to anyone who can see
	// the file: a role that may open a document but not save a copy of it is a
	// real configuration, and folding the two together would turn every
	// read-only reviewer into someone who cannot read.
	OpDownload = "files.download"
	// OpShare — mint a public link.
	OpShare = "files.share"
	// OpGrant — hand another account access to an item (the permissions panel,
	// invites, share-mail).
	OpGrant = "files.grant"
	// OpTags — set the per-user tags on a node.
	OpTags = "files.tags"
	// OpStar — set the per-user starred flag on a node.
	OpStar = "files.star"
)

// Wildcard is the single entry that stands for every operation, present and
// future. Only the admin role carries it, and it is not editable.
const Wildcard = "*"

// Group names — how the admin UI lays the catalogue out. Purely presentational;
// nothing enforces on a group.
const (
	GroupWrite    = "write"
	GroupOrganise = "organise"
	GroupRead     = "read"
	GroupShare    = "share"
)

// Op is one catalogue entry.
type Op struct {
	ID    string `json:"id"`
	Group string `json:"group"`
}

// Catalogue is every operation this build enforces, in the order the admin
// screen should draw them (grouped, and within a group in the order a person
// meets them while using the product). It is the ONLY source of valid
// operation ids: PUT /api/admin/roles/{name} validates against it, so a
// typo'd operation is a 400 rather than a silently-dead row.
var Catalogue = []Op{
	{ID: OpUpload, Group: GroupWrite},
	{ID: OpMkdir, Group: GroupWrite},

	{ID: OpRename, Group: GroupOrganise},
	{ID: OpMove, Group: GroupOrganise},
	{ID: OpCopy, Group: GroupOrganise},
	{ID: OpDelete, Group: GroupOrganise},
	{ID: OpPurge, Group: GroupOrganise},
	{ID: OpRestore, Group: GroupOrganise},
	{ID: OpTags, Group: GroupOrganise},

	{ID: OpDownload, Group: GroupRead},
	{ID: OpStar, Group: GroupRead},

	{ID: OpShare, Group: GroupShare},
	{ID: OpGrant, Group: GroupShare},
}

// AllOps returns every catalogue id, in catalogue order. A fresh slice each
// call — callers marshal it straight into a response.
func AllOps() []string {
	out := make([]string, 0, len(Catalogue))
	for _, o := range Catalogue {
		out = append(out, o.ID)
	}
	return out
}

// Known reports whether op is a catalogue entry.
func Known(op string) bool {
	for _, o := range Catalogue {
		if o.ID == op {
			return true
		}
	}
	return false
}

// Defaults is what a fresh installation gives each role, and what migration
// 00044 writes over the legacy `files.read`/`files.write`/`files.delete`/
// `files.share` vocabulary.
//
//   - admin keeps the wildcard and is not editable.
//   - user gets everything — the role is unchanged from before this feature,
//     which is the whole point: nobody's install changes behaviour on upgrade.
//   - viewer gets download + star. That is exactly what a viewer could already
//     do (acl.RoleCeiling pins them to viewer level on every item, so every
//     mutation was already refused); the entry exists so the screen shows the
//     truth rather than an empty box.
var Defaults = map[string][]string{
	"admin":  {Wildcard},
	"user":   AllOps(),
	"viewer": {OpDownload, OpStar},
}
