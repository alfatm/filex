package handlers_test

// Upload conflicts are decided on the server: `if_exists` on begin, commit and
// the multipart fast path, plus the active-upload lock that keeps two sessions
// from replacing one file while bytes are actually flowing.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
)

// commitWith is commit with a JSON body.
func (f *stagedFixture) commitWith(t *testing.T, id string, body map[string]any) (int, map[string]any) {
	t.Helper()
	buf, _ := json.Marshal(body)
	resp, err := f.client.Post(f.srv.URL+"/api/files/upload/"+id+"/commit", "application/json", bytes.NewReader(buf))
	require.NoError(t, err)
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// fastUpload posts one file through `?action=upload` with optional extra fields.
func (f *stagedFixture) fastUpload(t *testing.T, name string, content []byte, extra map[string]string) (int, map[string]any) {
	t.Helper()
	fields := map[string]string{"path": "main://"}
	for k, v := range extra {
		fields[k] = v
	}
	body, ctype := multipartBody(t, "file[]", name, content, fields)
	req, err := http.NewRequest(http.MethodPost, f.srv.URL+"/api/files/manager?action=upload", body)
	require.NoError(t, err)
	req.Header.Set("Content-Type", ctype)
	resp, err := f.client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// ageStagedUpload moves a row's last activity back so it reads as stalled.
// sqlite's CURRENT_TIMESTAMP is UTC text, and so is datetime('now', …).
func (f *stagedFixture) ageStagedUpload(t *testing.T, id, modifier string) {
	t.Helper()
	_, err := f.sqlDB.Exec(`UPDATE staged_uploads SET updated_at=datetime('now', ?) WHERE id=?`, modifier, id)
	require.NoError(t, err)
}

func (f *stagedFixture) stagedState(t *testing.T, id string) string {
	t.Helper()
	row, err := f.store.GetStagedUpload(context.Background(), id)
	require.NoError(t, err)
	return row.State
}

func TestStagedUpload_BeginIfExists(t *testing.T) {
	f := newStagedFixture(t)

	// The fast path leaves both a node row and the bytes behind.
	code, _ := f.fastUpload(t, "taken.txt", []byte("v1"), nil)
	require.Equal(t, http.StatusOK, code)

	code, body := f.begin(t, map[string]any{"path": "main://", "name": "taken.txt", "size": 2, "if_exists": "fail"})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "EXISTS", body["code"])

	// A file the catalogue does not know about is still a file.
	require.NoError(t, os.WriteFile(filepath.Join(f.rootDir, "outside.txt"), []byte("x"), 0o644))
	code, body = f.begin(t, map[string]any{"path": "main://", "name": "outside.txt", "size": 2, "if_exists": "fail"})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "EXISTS", body["code"])

	code, _ = f.begin(t, map[string]any{"path": "main://", "name": "free.txt", "size": 2, "if_exists": "fail"})
	assert.Equal(t, http.StatusOK, code)

	code, _ = f.begin(t, map[string]any{"path": "main://", "name": "taken.txt", "size": 2, "if_exists": "replace"})
	assert.Equal(t, http.StatusOK, code)

	code, _ = f.begin(t, map[string]any{"path": "main://", "name": "other.txt", "size": 2, "if_exists": "ask"})
	assert.Equal(t, http.StatusBadRequest, code)
}

// The row does not remember the begin-time choice and the target may appear
// after begin, so commit re-checks — and a refusal leaves the session
// committable with `replace`.
func TestStagedUpload_CommitIfExists_RecheckedAndRetryable(t *testing.T) {
	f := newStagedFixture(t)
	content := []byte("staged bytes win")

	code, b := f.begin(t, map[string]any{"path": "main://", "name": "late.txt", "size": len(content), "if_exists": "fail"})
	require.Equal(t, http.StatusOK, code)
	id := b["id"].(string)
	code, _ = f.putChunk(t, id, 0, int64(len(content)), int64(len(content)), content)
	require.Equal(t, http.StatusOK, code)

	// Somebody else put a file there in the meantime.
	require.NoError(t, os.WriteFile(filepath.Join(f.rootDir, "late.txt"), []byte("first"), 0o644))

	code, body := f.commitWith(t, id, map[string]any{"if_exists": "fail"})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "EXISTS", body["code"])
	assert.Equal(t, model.StagedUploadStaging, f.stagedState(t, id))
	got, err := os.ReadFile(filepath.Join(f.rootDir, "late.txt"))
	require.NoError(t, err)
	assert.Equal(t, "first", string(got), "refusal must not touch the existing file")

	code, _ = f.commitWith(t, id, map[string]any{"if_exists": "keep-both"})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, model.StagedUploadStaging, f.stagedState(t, id))

	code, body = f.commitWith(t, id, map[string]any{"if_exists": "replace"})
	require.Equal(t, http.StatusAccepted, code)
	require.Equal(t, "ok", f.waitForOp(t, num(body["op_id"])))
	waitForStored(t, f, "late.txt", len(content))
	got, err = os.ReadFile(filepath.Join(f.rootDir, "late.txt"))
	require.NoError(t, err)
	assert.Equal(t, content, got)
}

func TestStagedUpload_ActiveTargetLock_OnBegin(t *testing.T) {
	f := newStagedFixture(t)
	total := int64(8192)
	req := map[string]any{"path": "main://", "name": "lock.bin", "size": total, "chunk_size": 4096}

	code, b := f.begin(t, req)
	require.Equal(t, http.StatusOK, code)
	first := b["id"].(string)
	code, _ = f.putChunk(t, first, 0, 4096, total, randomBytes(4096))
	require.Equal(t, http.StatusOK, code)

	code, body := f.begin(t, req)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "UPLOAD_IN_PROGRESS", body["code"])

	// A different name in the same folder is not locked.
	code, _ = f.begin(t, map[string]any{"path": "main://", "name": "other.bin", "size": total})
	assert.Equal(t, http.StatusOK, code)

	// Silent for two minutes: stalled, not flowing.
	f.ageStagedUpload(t, first, "-2 minutes")
	code, b = f.begin(t, req)
	require.Equal(t, http.StatusOK, code)
	second := b["id"].(string)
	require.Equal(t, http.StatusOK, f.abort(t, second))

	// A committing row is moving bytes to the driver and locks at any age.
	_, err := f.sqlDB.Exec(`UPDATE staged_uploads SET state='committing' WHERE id=?`, first)
	require.NoError(t, err)
	code, body = f.begin(t, req)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "UPLOAD_IN_PROGRESS", body["code"])
}

// A stalled session that resumes while a newer one has taken the target is
// refused at commit, keeps its row, and commits once the newer one is gone.
func TestStagedUpload_ActiveTargetLock_OnCommit(t *testing.T) {
	f := newStagedFixture(t)
	content := []byte("resumed after a stall")
	req := map[string]any{"path": "main://", "name": "race.txt", "size": len(content)}

	code, b := f.begin(t, req)
	require.Equal(t, http.StatusOK, code)
	stalled := b["id"].(string)
	code, _ = f.putChunk(t, stalled, 0, int64(len(content)), int64(len(content)), content)
	require.Equal(t, http.StatusOK, code)
	f.ageStagedUpload(t, stalled, "-2 minutes")

	code, b = f.begin(t, req)
	require.Equal(t, http.StatusOK, code)
	newer := b["id"].(string)

	code, body := f.commit(t, stalled)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "UPLOAD_IN_PROGRESS", body["code"])
	assert.Equal(t, model.StagedUploadStaging, f.stagedState(t, stalled))

	require.Equal(t, http.StatusOK, f.abort(t, newer))
	code, body = f.commit(t, stalled)
	require.Equal(t, http.StatusAccepted, code)
	require.Equal(t, "ok", f.waitForOp(t, num(body["op_id"])))
	waitForStored(t, f, "race.txt", len(content))
}

func TestLegacyMultipartUpload_ConflictsAndLock(t *testing.T) {
	f := newStagedFixture(t)

	code, b := f.begin(t, map[string]any{"path": "main://", "name": "busy.txt", "size": 4})
	require.Equal(t, http.StatusOK, code)
	code, body := f.fastUpload(t, "busy.txt", []byte("fast"), nil)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "UPLOAD_IN_PROGRESS", body["code"])
	_, err := os.Stat(filepath.Join(f.rootDir, "busy.txt"))
	assert.True(t, os.IsNotExist(err), "nothing may be written on a refusal")

	require.Equal(t, http.StatusOK, f.abort(t, b["id"].(string)))
	code, _ = f.fastUpload(t, "busy.txt", []byte("fast"), nil)
	require.Equal(t, http.StatusOK, code)

	code, body = f.fastUpload(t, "busy.txt", []byte("again"), map[string]string{"if_exists": "fail"})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "EXISTS", body["code"])
	got, err := os.ReadFile(filepath.Join(f.rootDir, "busy.txt"))
	require.NoError(t, err)
	assert.Equal(t, "fast", string(got))

	code, _ = f.fastUpload(t, "busy.txt", []byte("again"), map[string]string{"if_exists": "replace"})
	require.Equal(t, http.StatusOK, code)
	got, err = os.ReadFile(filepath.Join(f.rootDir, "busy.txt"))
	require.NoError(t, err)
	assert.Equal(t, "again", string(got))

	code, _ = f.fastUpload(t, "busy.txt", []byte("x"), map[string]string{"if_exists": "skip"})
	assert.Equal(t, http.StatusBadRequest, code)
}
