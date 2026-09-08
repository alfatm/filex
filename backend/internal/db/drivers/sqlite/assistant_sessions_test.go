package sqlite_test

// The eviction rule, which is the only part of the assistant's storage with an
// opinion in it: a hundred conversations per account, and the one that goes is
// the least recently ACTIVE — not the oldest. A thread somebody returns to every
// week is not old, however long ago it started, and ordering by creation would
// throw away exactly the conversations people rely on.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestAssistantSessionsEvictByLastActivityNotByAge(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "ada@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)

	// Three sessions, created oldest-first.
	var made []*model.AssistantSession
	for _, title := range []string{"oldest", "middle", "newest"} {
		s, cerr := store.CreateAssistantSession(ctx, &model.AssistantSession{UserID: user.ID, Title: title})
		require.NoError(t, cerr)
		made = append(made, s)
	}
	// The OLDEST one is the one still in use: a message lands in it now.
	_, err = store.AppendAssistantMessage(ctx, &model.AssistantMessage{
		SessionID: made[0].ID, Role: model.AssistantRoleUser, Content: "still here",
	})
	require.NoError(t, err)

	// Keep two: the one that goes must be "middle" — created after "oldest" but
	// untouched since.
	removed, err := store.EvictAssistantSessions(ctx, user.ID, 2)
	require.NoError(t, err)
	assert.Equal(t, 1, removed)

	left, err := store.ListAssistantSessions(ctx, user.ID, 100)
	require.NoError(t, err)
	titles := []string{}
	for _, s := range left {
		titles = append(titles, s.Title)
	}
	assert.Equal(t, []string{"oldest", "newest"}, titles, "most recently active first; the untouched middle one was dropped")
}

func TestAssistantSessionEvictionTakesTheMessagesWithIt(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "mert@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)

	doomed, err := store.CreateAssistantSession(ctx, &model.AssistantSession{UserID: user.ID, Title: "doomed"})
	require.NoError(t, err)
	_, err = store.AppendAssistantMessage(ctx, &model.AssistantMessage{
		SessionID: doomed.ID, Role: model.AssistantRoleUser, Content: "a question nobody may read afterwards",
	})
	require.NoError(t, err)

	// Keeping zero evicts everything.
	removed, err := store.EvictAssistantSessions(ctx, user.ID, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, removed)

	msgs, err := store.ListAssistantMessages(ctx, doomed.ID)
	require.NoError(t, err)
	assert.Empty(t, msgs, "a purged conversation leaves no messages behind")
}

func TestAppendAssistantMessageMovesTheSessionWithIt(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "lee@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	session, err := store.CreateAssistantSession(ctx, &model.AssistantSession{UserID: user.ID})
	require.NoError(t, err)
	before := session.LastActiveAt

	time.Sleep(2 * time.Millisecond)
	stored, err := store.AppendAssistantMessage(ctx, &model.AssistantMessage{
		SessionID: session.ID, Role: model.AssistantRoleAssistant, Content: "half an answer", Aborted: true,
	})
	require.NoError(t, err)

	again, err := store.GetAssistantSession(ctx, session.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, again.MessageCount, "a stored message never leaves the session looking untouched")
	assert.True(t, again.LastActiveAt.After(before), "and it moves the activity stamp eviction reads")

	msgs, err := store.ListAssistantMessages(ctx, session.ID)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	assert.Equal(t, stored.ID, msgs[0].ID)
	assert.True(t, msgs[0].Aborted, "a turn the person stopped keeps what had been written, marked as stopped")
	assert.Equal(t, "{}", msgs[0].PayloadJSON)
}

func TestAssistantTitleStaysOnceAPersonChoseIt(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "ren@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	session, err := store.CreateAssistantSession(ctx, &model.AssistantSession{UserID: user.ID, Title: "Q3 contracts"})
	require.NoError(t, err)

	require.NoError(t, store.SetAssistantSessionTitle(ctx, session.ID, "Invoices", true))
	again, err := store.GetAssistantSession(ctx, session.ID)
	require.NoError(t, err)
	assert.Equal(t, "Invoices", again.Title)
	assert.True(t, again.TitleManual, "the generator reads this flag and leaves a chosen name alone")
}

// Permission to read a file: exact paths only, repeatable without piling up
// rows, and gone when the conversation is.
func TestAssistantReadGrantsAreExactAndDieWithTheConversation(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "kai@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	session, err := store.CreateAssistantSession(ctx, &model.AssistantSession{UserID: user.ID})
	require.NoError(t, err)
	other, err := store.CreateAssistantSession(ctx, &model.AssistantSession{UserID: user.ID})
	require.NoError(t, err)

	granted, err := store.AssistantReadGranted(ctx, session.ID, "main://Docs/pay.csv")
	require.NoError(t, err)
	assert.False(t, granted, "nothing is readable until it is approved")

	require.NoError(t, store.GrantAssistantRead(ctx, session.ID, "main://Docs/pay.csv"))
	// Approving the same file twice is one permission, not two rows.
	require.NoError(t, store.GrantAssistantRead(ctx, session.ID, "main://Docs/pay.csv"))
	paths, err := store.ListAssistantReadGrants(ctx, session.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{"main://Docs/pay.csv"}, paths)

	// ⚠ Exact match. Neither the folder, nor a sibling, nor a longer path that
	// starts with the approved one is covered by it.
	for _, near := range []string{
		"main://Docs",
		"main://Docs/",
		"main://Docs/pay.csv.bak",
		"main://Docs/other.csv",
		"MAIN://Docs/pay.csv",
	} {
		granted, err = store.AssistantReadGranted(ctx, session.ID, near)
		require.NoError(t, err)
		assert.False(t, granted, "%s must not be covered by the approval of pay.csv", near)
	}

	// Consent belongs to the conversation it was given in.
	granted, err = store.AssistantReadGranted(ctx, other.ID, "main://Docs/pay.csv")
	require.NoError(t, err)
	assert.False(t, granted, "another conversation starts with no permissions")

	require.NoError(t, store.DeleteAssistantSession(ctx, session.ID))
	paths, err = store.ListAssistantReadGrants(ctx, session.ID)
	require.NoError(t, err)
	assert.Empty(t, paths, "deleting a chat takes what it was allowed to read with it")
}

// A plan runs at most once, and only from pending. Two approvals racing is not
// hypothetical: it is a double click.
func TestAssistantPlanIsDecidedExactlyOnce(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "mo@filex.test", "x", "user", "en", "UTC")
	require.NoError(t, err)
	session, err := store.CreateAssistantSession(ctx, &model.AssistantSession{UserID: user.ID})
	require.NoError(t, err)

	plan, err := store.CreateAssistantPlan(ctx, &model.AssistantPlan{
		SessionID: session.ID, Kind: model.PlanKindTags,
		Summary: "Tag the invoices", ItemsJSON: `[{"path":"main://a.pdf","node_id":7}]`,
	})
	require.NoError(t, err)
	assert.Equal(t, model.PlanPending, plan.Status, "a plan starts as a question, not as work")
	assert.Nil(t, plan.DecidedAt)

	ran, err := store.FinishAssistantPlan(ctx, plan.ID, model.PlanDone, `{"items":[{"path":"main://a.pdf","state":"done"}]}`)
	require.NoError(t, err)
	assert.True(t, ran)

	// The second attempt changes nothing and says so — that is what stops a
	// retried request from running the work twice.
	ran, err = store.FinishAssistantPlan(ctx, plan.ID, model.PlanDone, "{}")
	require.NoError(t, err)
	assert.False(t, ran)

	again, err := store.GetAssistantPlan(ctx, plan.ID)
	require.NoError(t, err)
	assert.Equal(t, model.PlanDone, again.Status)
	assert.Contains(t, again.ResultJSON, "done")
	require.NotNil(t, again.DecidedAt)

	plans, err := store.ListAssistantPlans(ctx, session.ID)
	require.NoError(t, err)
	require.Len(t, plans, 1)

	// Deleting the conversation takes its plans with it.
	require.NoError(t, store.DeleteAssistantSession(ctx, session.ID))
	plans, err = store.ListAssistantPlans(ctx, session.ID)
	require.NoError(t, err)
	assert.Empty(t, plans)
}
