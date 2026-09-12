package handlers_test

// N-2: a rename or move that only changes the case of a name is not a
// collision, but ensureNameFree used to read it as one. It asked Stat(dst)
// alone, and on a case-INSENSITIVE backend (SMB, WebDAV) Stat("A.txt")
// answers with the very file sitting at "a.txt" — so the guard refused the
// caller's own file with a 409 and "a.txt" could never be capitalised.
//
// The fix compares identity, not spelling: only when dst and src differ
// merely in case does the guard Stat both and check the two Objects agree on
// Kind+Size+Mtime+Etag. A case-SENSITIVE backend holding a genuinely
// different file at "SRC.TXT" reports a different Object, and the 409 stands.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// caseDriver is a driver whose case sensitivity is a knob. It has to be one:
// the local driver is only ever as case-sensitive as the host filesystem
// (sensitive on Linux, insensitive on stock macOS/APFS), so neither half of
// this behaviour can be pinned down against it.
type caseDriver struct {
	insensitive bool
	objects     map[string]storage.Object // keyed by the exact stored path
}

// lookup resolves p to a stored key, folding case only when insensitive.
func (d *caseDriver) lookup(p string) (string, bool) {
	p = strings.Trim(p, "/")
	if _, ok := d.objects[p]; ok {
		return p, true
	}
	if d.insensitive {
		for k := range d.objects {
			if strings.EqualFold(k, p) {
				return k, true
			}
		}
	}
	return "", false
}

func (d *caseDriver) Init(context.Context, map[string]any) error { return nil }
func (d *caseDriver) Name() string                               { return "case" }

func (d *caseDriver) Stat(_ context.Context, p string) (storage.Object, error) {
	if k, ok := d.lookup(p); ok {
		return d.objects[k], nil
	}
	return storage.Object{}, storage.ErrNotFound
}

func (d *caseDriver) List(_ context.Context, p string) ([]storage.Object, error) {
	want := strings.Trim(p, "/")
	out := []storage.Object{}
	for k, o := range d.objects {
		parent := strings.Trim(path.Dir("/"+k), "/")
		if parent == want || (d.insensitive && strings.EqualFold(parent, want)) {
			out = append(out, o)
		}
	}
	return out, nil
}

func (d *caseDriver) Read(context.Context, string) (io.ReadCloser, error) {
	return nil, storage.ErrNotFound
}

func (d *caseDriver) Capabilities() storage.Capabilities {
	return storage.Capabilities{Read: true, Move: true}
}

func (d *caseDriver) Move(_ context.Context, src, dst string) error {
	k, ok := d.lookup(src)
	if !ok {
		return storage.ErrNotFound
	}
	o := d.objects[k]
	delete(d.objects, k)
	dst = strings.Trim(dst, "/")
	o.Path, o.Name = dst, path.Base(dst)
	d.objects[dst] = o
	return nil
}

func newCaseFixture(t *testing.T, insensitive bool, objects map[string]storage.Object) (*handlers.Manager, *caseDriver) {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name:       "main",
		Driver:     "smb",
		MountPath:  "/data",
		Enabled:    true,
		ConfigJSON: json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	drv := &caseDriver{insensitive: insensitive, objects: objects}
	resolver := func(id int64) (storage.Driver, error) {
		if id == st.ID {
			return drv, nil
		}
		return nil, fmt.Errorf("unknown id %d", id)
	}
	return handlers.NewManager(store, resolver), drv
}

// caseObj builds a file Object with a fixed mtime, so "same object" is a fact
// about the two Stats and not about when the test happened to run.
func caseObj(p string, size int64, etag string) storage.Object {
	return storage.Object{
		Path:  p,
		Name:  path.Base(p),
		Size:  size,
		Kind:  storage.KindFile,
		Etag:  etag,
		Mtime: time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC),
	}
}

// ---------- vfRename ----------

// The N-2 regression: on a case-insensitive backend the destination Stat
// resolves back to the source, which is not a collision.
func TestManagerMutate_Rename_CaseOnly_CaseInsensitiveBackend_OK(t *testing.T) {
	mh, drv := newCaseFixture(t, true, map[string]storage.Object{
		"a.txt": caseObj("a.txt", 12, "e1"),
	})

	rec := callMutate(t, mh, "rename", map[string]any{
		"path": "main://",
		"item": "main://a.txt",
		"name": "A.txt",
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	_, ok := drv.objects["A.txt"]
	assert.True(t, ok, "the case-only rename never reached the driver")
	assert.Len(t, drv.objects, 1, "the rename duplicated the entry")
}

// The other half: a case-SENSITIVE backend really does hold a second, different
// file at the capitalised name, and that is still a 409.
func TestManagerMutate_Rename_CaseOnly_RealOtherFile_409(t *testing.T) {
	mh, drv := newCaseFixture(t, false, map[string]storage.Object{
		"src.txt": caseObj("src.txt", 12, "e1"),
		"SRC.TXT": caseObj("SRC.TXT", 6, "e2"),
	})

	rec := callMutate(t, mh, "rename", map[string]any{
		"path": "main://",
		"item": "main://src.txt",
		"name": "SRC.TXT",
	})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	// Neither entry moved: the victim keeps its own bytes, the source stays.
	assert.Equal(t, int64(6), drv.objects["SRC.TXT"].Size, "the rename target was replaced")
	assert.Equal(t, int64(12), drv.objects["src.txt"].Size)
}

// ---------- vfMove ----------

// A move keeps the basename, so a destination directory that differs from the
// source's only in case produces a dst that folds onto src — same false 409.
func TestManagerMutate_Move_CaseOnlyDir_CaseInsensitiveBackend_OK(t *testing.T) {
	mh, drv := newCaseFixture(t, true, map[string]storage.Object{
		"Dir/x.txt": caseObj("Dir/x.txt", 9, "e1"),
	})

	rec := callMutate(t, mh, "move", map[string]any{
		"path":  "main://dir",
		"items": []map[string]any{{"path": "main://Dir/x.txt"}},
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	_, ok := drv.objects["dir/x.txt"]
	assert.True(t, ok, "the case-only move never reached the driver")
	assert.Len(t, drv.objects, 1, "the move duplicated the entry")
}

// And a real different file under the case-sensitive spelling still collides.
func TestManagerMutate_Move_CaseOnlyDir_RealOtherFile_409(t *testing.T) {
	mh, drv := newCaseFixture(t, false, map[string]storage.Object{
		"Dir/x.txt": caseObj("Dir/x.txt", 9, "e1"),
		"dir/x.txt": caseObj("dir/x.txt", 4, "e2"),
	})

	rec := callMutate(t, mh, "move", map[string]any{
		"path":  "main://dir",
		"items": []map[string]any{{"path": "main://Dir/x.txt"}},
	})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	assert.Equal(t, int64(4), drv.objects["dir/x.txt"].Size, "the move target was replaced")
	assert.Equal(t, int64(9), drv.objects["Dir/x.txt"].Size)
}
