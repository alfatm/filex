package handlers_test

// The read-only flag on a storage has to mean the same thing whichever door the
// request comes through. The synchronous manager (`?q=move|delete`) refused a
// read-only storage from the start; the queue never asked, so the same delete
// answered 403 in one place and 202 in the other — and the 202 was the one that
// actually emptied the depo into its trash.
//
// A copy is the exception on purpose: it only READS its source. What it must
// not do is write into a read-only destination, which the queue already
// refused and which stays covered by the cross-storage tests.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func submitDelete(t *testing.T, f *crossHTTPFixture, sources ...string) *httptest.ResponseRecorder {
	t.Helper()
	buf, err := json.Marshal(map[string]any{"source": sources})
	require.NoError(t, err)
	req := httptest.NewRequest("POST", "/api/files/delete", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.oh.SubmitDelete(rec, req)
	return rec
}

func TestOpsHTTP_Delete_RefusesAReadOnlySource(t *testing.T) {
	f := newCrossHTTPFixture(t, true)
	require.NoError(t, os.WriteFile(filepath.Join(f.rootB, "kalsin.txt"), []byte("dur"), 0o644))

	rec := submitDelete(t, f, "beta://kalsin.txt")
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "read-only")

	// Refused at submit time means nothing was queued: the file is still there
	// after the worker has had its chance.
	f.drain(t)
	_, err := os.Stat(filepath.Join(f.rootB, "kalsin.txt"))
	require.NoError(t, err, "a refused delete may not reach the disk")
}

func TestOpsHTTP_Move_RefusesAReadOnlySource(t *testing.T) {
	f := newCrossHTTPFixture(t, true)
	require.NoError(t, os.WriteFile(filepath.Join(f.rootB, "sabit.txt"), []byte("dur"), 0o644))

	rec := f.post(t, "move", map[string]any{
		"source": []string{"beta://sabit.txt"},
		"target": "alpha://",
	})
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	f.drain(t)
	_, err := os.Stat(filepath.Join(f.rootB, "sabit.txt"))
	require.NoError(t, err, "a move out of a read-only depo is still a write to that depo")
}

func TestOpsHTTP_Copy_AllowsAReadOnlySource(t *testing.T) {
	f := newCrossHTTPFixture(t, true)
	require.NoError(t, os.WriteFile(filepath.Join(f.rootB, "oku.txt"), []byte("serbest"), 0o644))

	rec := f.post(t, "copy", map[string]any{
		"source": []string{"beta://oku.txt"},
		"target": "alpha://",
	})
	require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
	f.drain(t)

	body, err := os.ReadFile(filepath.Join(f.rootA, "oku.txt"))
	require.NoError(t, err, "reading out of a read-only depo is allowed")
	require.Equal(t, "serbest", string(body))
	_, err = os.Stat(filepath.Join(f.rootB, "oku.txt"))
	require.NoError(t, err, "and the original stays where it is")
}
