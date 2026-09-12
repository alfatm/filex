package handlers_test

// The assistant driven by an ORDINARY account.
//
// Every other assistant suite logs in as the administrator, and an
// administrator is Owner everywhere by definition: `allow`, `mayWriteNode` and
// every `reasonForbidden` branch answer yes before they look at anything. So
// the tool loop was covered and the gate around it was not — the tests walked
// exactly the paths that protect nothing.
//
// Everything here is asserted where the leak would be real: on what filex SENT
// THE PROVIDER (a tool result travels to the model and from there off this
// installation), and on the state of the file afterwards.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/share"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// assistantAsViewer boots the assistant fixture, adds a branch of the drive the
// caller holds nothing on, switches RBAC on, and returns a client logged in as
// an ordinary account holding VIEWER on `notes` — enough to look, not enough to
// change anything.
//
// Viewer rather than editor on purpose: the reads have to keep working, so a
// refusal in these tests is a refusal about the level and not about visibility.
func assistantAsViewer(t *testing.T, provider *scriptedProvider) (*httptest.Server, *http.Client, db.Store, *model.Storage) {
	t.Helper()
	srv, admin, store := assistantFiles(t, provider)
	ctx := context.Background()

	storages, err := store.ListEnabledStorages(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, storages)
	st := storages[0]

	// The drive's root on disk, so the branch below is real: a guard that is
	// removed must produce actual filenames, or the test proves nothing.
	var cfg struct {
		Root string `json:"root"`
	}
	require.NoError(t, json.Unmarshal(st.ConfigJSON, &cfg))
	require.NotEmpty(t, cfg.Root)
	require.NoError(t, os.MkdirAll(filepath.Join(cfg.Root, "hr"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(cfg.Root, "hr", "wages.csv"), []byte("name,salary\nada,99999"), 0o644))
	for _, n := range []struct {
		path string
		kind model.NodeType
		size int64
	}{{"/hr", model.NodeTypeDirectory, 0}, {"/hr/wages.csv", model.NodeTypeFile, 21}} {
		_, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: filepath.Base(n.path), Path: n.path,
			PathHash: pathkey.Hash(st.ID, n.path), StorageKey: n.path,
			Type: n.kind, Size: n.size,
		})
		require.NoError(t, cerr)
	}

	// Without RBAC on, every account is editor everywhere and there is nothing
	// to refuse.
	st.RBACEnabled = true
	require.NoError(t, store.UpdateStorage(ctx, st))

	const email, pw = "okuyucu@filex.test", "TestUserPass!1"
	userID := createUser(t, srv.URL, admin, email, pw, model.RoleUser)
	testutil.GrantPath(t, store, st.ID, userID, "notes", model.GrantViewer)

	client := freshClient(t)
	testutil.LoginAs(t, srv, client, email, pw)
	return srv, client, store, st
}

func TestAssistantTools_ListFolderRefusesABranchTheAccountWasNotGiven(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "list_folder", map[string]any{"path": "main://hr"}),
		// The model is told it may not look, and answers from that.
		textFrame("I cannot see that folder."),
		toolFrame("call_2", "list_folder", map[string]any{"path": "main://notes"}),
		textFrame("There are two files in notes."),
	)
	srv, client, _, _ := assistantAsViewer(t, provider)
	session := newSession(t, srv, client)
	turnURL := srv.URL + "/api/assistant/sessions/" + session + "/turn"

	turnStream(t, client, turnURL, "what is in hr?")
	sent := provider.sent()
	assert.NotContains(t, sent, "wages.csv",
		"a folder the person was not given must not be read back to the model, let alone to its provider")
	assert.NotContains(t, sent, "99999")
	assert.Contains(t, sent, "no permission for main://hr",
		"the model is told it was refused, so it can say so instead of guessing")

	// The refusal is about the branch, not about the account: the folder it was
	// granted still lists, which is what makes the assertion above meaningful.
	turnStream(t, client, turnURL, "then what is in notes?")
	assert.Contains(t, provider.sent(), "hello.txt")
}

// plan_tags does not check permission while it PROPOSES — a tag plan is a list
// of node ids, and the level is asserted when the person approves it. So the
// interesting assertion is on execution: the item is refused, and the file's
// tags are exactly what they were.
func TestAssistantPlan_TaggingIsRefusedForAViewerAndTheTagsDoNotMove(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_tags", map[string]any{
			"paths": []string{"main://notes/pay.csv"}, "tags": []string{"gizli"},
			"summary": "Tag the payroll file",
		}),
		textFrame("I have proposed tagging it."),
	)
	srv, client, store, _ := assistantAsViewer(t, provider)
	session := newSession(t, srv, client)
	ctx := context.Background()

	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "tag the payroll file")
	card := planCard(t, events)
	planID, _ := card["plan_id"].(string)
	require.NotEmpty(t, planID)

	node := nodeAt(t, store, "main://notes/pay.csv")
	before, err := store.GetNodeTags(ctx, node.ID)
	require.NoError(t, err)

	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	var outcome struct {
		Done    int `json:"done"`
		Skipped int `json:"skipped"`
		Failed  int `json:"failed"`
		Items   []struct {
			State string `json:"state"`
			Code  string `json:"code"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	assert.Zero(t, outcome.Done)
	assert.Zero(t, outcome.Failed)
	require.Equal(t, 1, outcome.Skipped)
	assert.Equal(t, "skipped", outcome.Items[0].State)
	assert.Equal(t, "forbidden", outcome.Items[0].Code,
		"a closed code, so the panel can say why in the reader's language")

	after, err := store.GetNodeTags(ctx, node.ID)
	require.NoError(t, err)
	assert.Equal(t, before, after, "the refusal has to be a refusal in the catalogue, not only in the answer")
	assert.NotContains(t, after, "gizli")
}

// Revoking a link somebody else made. The rule is the AI surface's own — your
// own links, unless you are an administrator — and it is now asserted while the
// plan is BUILT as well as at execution: a card the person cannot approve is
// worse than a refusal, because they have to read it to find that out. The
// assertions here are on the build, since nothing gets as far as a plan row.
func TestAssistantPlan_RevokingSomebodyElsesLinkIsRefusedAndTheLinkStillWorks(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_revoke_share", map[string]any{
			"path": "main://notes/hello.txt", "share_id": 1, "summary": "Close the public link",
		}),
		textFrame("I have proposed closing it."),
	)
	srv, client, store, _ := assistantAsViewer(t, provider)
	ctx := context.Background()

	// The link is the ADMINISTRATOR's, on a file the viewer can see.
	admin, err := store.GetUserByEmail(ctx, "admin@test.local")
	require.NoError(t, err)
	require.NotNil(t, admin)
	node := nodeAt(t, store, "main://notes/hello.txt")
	shares := share.NewService(store)
	link, err := shares.Create(ctx, share.CreateOpts{NodeID: node.ID, CreatedBy: &admin.ID})
	require.NoError(t, err)
	require.EqualValues(t, 1, link.ID, "the scripted tool call names share_id 1")

	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "close the link on hello.txt")

	// No card at all: the refusal happens while the plan is proposed, so the
	// person is never shown an Approve button for work that cannot be done.
	assert.Empty(t, eventsOfType(events, "card"),
		"a plan the person may not approve must not be put in front of them")
	assert.Contains(t, provider.sent(), "created by somebody else",
		"the model is told it was refused, so it can say so instead of waiting for an approval")

	// And no plan row was stored either.
	sessionID, err := strconv.ParseInt(session, 10, 64)
	require.NoError(t, err)
	plans, err := store.ListAssistantPlans(ctx, sessionID)
	require.NoError(t, err)
	assert.Empty(t, plans)

	// Revoking sets expires_at to now, so "still open" is the honest check.
	after, err := shares.ListByNode(ctx, node.ID)
	require.NoError(t, err)
	require.Len(t, after, 1)
	assert.False(t, after[0].IsExpired(time.Now()),
		"the administrator's link is still open: a refused revoke must not half-close it")
}
