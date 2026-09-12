package handlers_test

// GET /api/files/download/zip, from the side of an account that was not given
// the folder.
//
// The zip walk is one of the very few read paths in filex that does not go
// through a listing projection: it asks the DRIVER for entries and copies their
// bytes. So the only thing standing between an ordinary account and somebody
// else's folder is the check in DownloadZip itself, and until now nothing
// exercised it — the whole suite drove the handler with no ACL resolver
// attached, where every path is allowed by definition.
//
// Every test here is written from the second account's side: it must be refused
// before a single zip byte is on the wire, because once a header is out the
// status is 200 for good and a refusal can only arrive as a truncated file.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/filebody"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type zipACLFixture struct {
	handler *handlers.Archive
	// reader holds viewer on `Ekip/genel` and nothing else; stranger holds
	// nothing at all. Neither is an admin: an admin is Owner everywhere by
	// definition and would prove nothing about the gate.
	reader   *model.User
	stranger *model.User
}

// newZipACLFixture seeds an RBAC-enabled drive holding three subtrees:
//
//	/Ekip/genel/notlar.md   — the one folder `reader` was granted
//	/Ekip/gizli/maas.csv    — a sibling under the same parent
//	/Baskasi/plan.md        — somebody else's folder entirely
func newZipACLFixture(t *testing.T) *zipACLFixture {
	t.Helper()
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	dir := t.TempDir()
	write := func(rel, body string) {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644))
	}
	write("Ekip/genel/notlar.md", "takim notlari")
	write("Ekip/gizli/maas.csv", "ada,99999")
	write("Baskasi/plan.md", "baskasinin plani")

	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": dir}))
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/data", Enabled: true, RBACEnabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + escapeJSON(dir) + `"}`),
	})
	require.NoError(t, err)

	reader := testutil.SeedUser(t, store, "okuyucu@filex.test", "TestUserPass!1")
	stranger := testutil.SeedUser(t, store, "yabanci@filex.test", "TestUserPass!1")
	testutil.GrantPath(t, store, st.ID, reader.ID, "Ekip/genel", model.GrantViewer)

	ah := handlers.NewArchive(store, func(id int64) (storage.Driver, error) {
		if id != st.ID {
			return nil, fmt.Errorf("unknown id %d", id)
		}
		return drv, nil
	})
	ah.AttachBody(filebody.New(store, nil))
	ah.AttachACL(acl.New(store))
	return &zipACLFixture{handler: ah, reader: reader, stranger: stranger}
}

// zipAs runs one download as `as`.
func (f *zipACLFixture) zipAs(t *testing.T, as *model.User, paths ...string) *httptest.ResponseRecorder {
	t.Helper()
	q := url.Values{"path": paths}
	req := httptest.NewRequest("GET", "/api/files/download/zip?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	f.handler.DownloadZip(rec, req.WithContext(auth.WithUser(req.Context(), as)))
	return rec
}

// refused asserts the whole shape of a refusal: the status, that no archive was
// started, and that none of the bytes being protected are in the answer.
func (f *zipACLFixture) refused(t *testing.T, rec *httptest.ResponseRecorder, secrets ...string) {
	t.Helper()
	assert.Equal(t, 403, rec.Code, rec.Body.String())
	assert.NotEqual(t, "application/zip", rec.Header().Get("Content-Type"),
		"a refusal must land before the zip header: after it the status is 200 for good")
	for _, s := range secrets {
		assert.NotContains(t, rec.Body.String(), s)
	}
}

func TestDownloadZip_RefusesAnAccountThatHoldsNoGrantOnTheFolder(t *testing.T) {
	f := newZipACLFixture(t)

	f.refused(t, f.zipAs(t, f.stranger, "main://Ekip/genel"), "takim notlari")
	f.refused(t, f.zipAs(t, f.stranger, "main://Ekip/genel/notlar.md"), "takim notlari")

	// The refusal has to stay a refusal of the stranger only: the account that
	// does hold the grant still gets its folder, whole.
	rec := f.zipAs(t, f.reader, "main://Ekip/genel")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	got := members(t, rec.Body.Bytes())
	require.Equal(t, "takim notlari", got["genel/notlar.md"])
	require.Len(t, got, 1)
}

// A grant on a subfolder is a grant on that subfolder. The parent is visible in
// the listing as a traversal node — that is what lets the person drill down to
// what they were given — and reading it as a zip would hand them every sibling
// under it.
func TestDownloadZip_AGrantOnASubfolderIsNotAGrantOnItsParent(t *testing.T) {
	f := newZipACLFixture(t)

	f.refused(t, f.zipAs(t, f.reader, "main://Ekip"), "ada,99999", "takim notlari")
	f.refused(t, f.zipAs(t, f.reader, "main://"), "ada,99999", "baskasinin plani")
	f.refused(t, f.zipAs(t, f.reader, "main://Ekip/gizli"), "ada,99999")
}

// A selection is authorised as a whole, before the archive is opened. Half an
// archive with no error in it is worse than a refusal: the browser saves it, the
// unpacker reads it, and nothing anywhere says a file is missing.
func TestDownloadZip_OneUnauthorisedRootRefusesTheWholeSelection(t *testing.T) {
	f := newZipACLFixture(t)

	rec := f.zipAs(t, f.reader, "main://Ekip/genel", "main://Ekip/gizli")
	f.refused(t, rec, "ada,99999", "takim notlari")

	// …and the same selection without the sibling still works, so the refusal
	// above is about the one root and not about mixed selections.
	ok := f.zipAs(t, f.reader, "main://Ekip/genel", "main://Ekip/genel/notlar.md")
	require.Equal(t, 200, ok.Code, ok.Body.String())
	got := members(t, ok.Body.Bytes())
	names := make([]string, 0, len(got))
	for n := range got {
		names = append(names, n)
	}
	sort.Strings(names)
	assert.Equal(t, []string{"genel/notlar.md", "notlar.md"}, names)
}
