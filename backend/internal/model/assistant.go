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
