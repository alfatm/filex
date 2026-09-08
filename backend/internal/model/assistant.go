package model

import "time"

// Assistant session limits. The cap is per USER, and it is a cap on history,
// not on use: reaching it evicts the least recently ACTIVE session rather than
// refusing a new one.
const (
	// MaxAssistantSessions is how many conversations one account keeps.
	MaxAssistantSessions = 100
	// AssistantTitleMaxRunes bounds the generated title. Counted in runes, not
	// bytes: the title is written in the user's language and Cyrillic would
	// otherwise get half the room Latin gets.
	AssistantTitleMaxRunes = 60
)

// What a plan does. Each kind has its own executor; there is no generic
// "apply these changes" path, so a kind nobody wrote an executor for cannot be
// run at all.
const (
	// PlanKindTags applies tags to files. The one bulk-safe operation the
	// owner allowed: a tag adds a label and destroys nothing.
	PlanKindTags = "tags"
	// PlanKindRestoreVersion puts an older revision back. Only on a direct
	// request, and it snapshots the current bytes first, so it is reversible.
	PlanKindRestoreVersion = "restore_version"
	// PlanKindRevokeShare closes a public link. Only on a direct request.
	PlanKindRevokeShare = "revoke_share"
	// PlanKindEmptyTrash destroys files for good. Only on a direct request,
	// never as a tidy-up step inside another plan.
	PlanKindEmptyTrash = "empty_trash"
)

// A plan's life: proposed, then either run once or dropped.
const (
	PlanPending   = "pending"
	PlanDone      = "done"
	PlanCancelled = "cancelled"
)

// How much one plan may carry.
//
// ⚠ Two ceilings, not one, because the two kinds of work are not comparable. A
// mistake in a thousand tags is a thousand labels to remove; a mistake in a
// thousand deletions is a thousand files that are gone. So anything that moves
// or destroys is capped low enough that a person can actually READ the list
// they are approving, and tagging — which adds a label and takes nothing away —
// is capped where bulk work stops being useful.
const (
	MaxPlanItems    = 50
	MaxPlanTagItems = 1000
)

// AssistantPlan is work the assistant proposed and the person may approve. See
// the migration for why the model never executes it itself.
type AssistantPlan struct {
	ID        int64  `json:"id"`
	SessionID int64  `json:"session_id"`
	Kind      string `json:"kind"`
	Summary   string `json:"summary"`
	// ItemsJSON is the resolved work: ids and fingerprints, not paths to be
	// re-interpreted later. Its shape belongs to the assistant handlers.
	ItemsJSON string `json:"items_json"`
	Status    string `json:"status"`
	// ResultJSON is what happened, per item, once it ran.
	ResultJSON string     `json:"result_json"`
	CreatedAt  time.Time  `json:"created_at"`
	DecidedAt  *time.Time `json:"decided_at,omitempty"`
}

// Assistant message roles.
const (
	AssistantRoleUser      = "user"
	AssistantRoleAssistant = "assistant"
)

// AssistantSession is one conversation. It carries no message text at all — see
// the migration for why the two tables are separate.
type AssistantSession struct {
	ID     int64 `json:"id"`
	UserID int64 `json:"user_id"`
	// Title is written by the title generator, or by the person renaming it.
	Title string `json:"title"`
	// TitleManual freezes the title against the generator: a name somebody
	// chose is not a name to overwrite.
	TitleManual  bool      `json:"title_manual"`
	MessageCount int       `json:"message_count"`
	LastActiveAt time.Time `json:"last_active_at"`
	CreatedAt    time.Time `json:"created_at"`
}

// AssistantMessage is one turn in a conversation.
type AssistantMessage struct {
	ID        int64  `json:"id"`
	SessionID int64  `json:"session_id"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	// PayloadJSON holds tool calls, result cards and approval records. Its shape
	// belongs to the assistant service; the store only carries it.
	PayloadJSON string `json:"payload_json,omitempty"`
	// Aborted marks a turn the person stopped part-way. What had been written
	// stays: they stopped having read the beginning, and the beginning is
	// usually what they wanted.
	Aborted bool `json:"aborted"`
	// SecretNotice marks an answer where the agent reported reading something
	// sensitive, so the interface can show that rather than leave it in prose.
	SecretNotice bool      `json:"secret_notice"`
	CreatedAt    time.Time `json:"created_at"`
}
