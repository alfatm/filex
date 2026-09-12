package handlers_test

// The ceilings added in migration 00042: the file COUNT limit, the upload
// WINDOW, and the tri-state that resolves a per-user override against the
// instance default.
//
// Everything here goes through the real router, because the thing being pinned
// is the WIRE contract the clients are written against — the status code, the
// `code` string, the Retry-After header — and none of that is visible from the
// service alone.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ── helpers ─────────────────────────────────────────────────────────────────

// patchJSON sends a PATCH and returns the status plus the decoded body.
func (f *stagedFixture) patchJSON(t *testing.T, url string, body any) (int, map[string]any) {
	t.Helper()
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewReader(buf))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// setOverrides PATCHes the fixture admin's own per-user tri-state overrides.
func (f *stagedFixture) setOverrides(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	code, out := f.patchJSON(t, fmt.Sprintf("%s/api/admin/users/%d/quota", f.srv.URL, f.userID), body)
	require.Equal(t, http.StatusOK, code, out)
	return out
}

// setDefaults PATCHes the instance defaults.
func (f *stagedFixture) setDefaults(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	return f.patchJSON(t, f.srv.URL+"/api/admin/quotas", body)
}

func (f *stagedFixture) quotaMe(t *testing.T) map[string]any {
	t.Helper()
	resp, err := f.client.Get(f.srv.URL + "/api/files/quota/me")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	out := map[string]any{}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return out
}

// beginRaw is begin() with access to the response headers, which is where
// Retry-After lives.
func (f *stagedFixture) beginRaw(t *testing.T, body map[string]any) (*http.Response, map[string]any) {
	t.Helper()
	buf, _ := json.Marshal(body)
	resp, err := f.client.Post(f.srv.URL+"/api/files/upload/begin", "application/json", bytes.NewReader(buf))
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return resp, out
}

// ── the file-count ceiling ──────────────────────────────────────────────────

// A new name is refused once the count is at the limit; an OVERWRITE of a file
// the account already owns is not, because it claims no new slot.
func TestQuota_Begin_FileLimitRefusesNewNameButAllowsOverwrite(t *testing.T) {
	f := newStagedFixture(t)

	f.uploadMultipart(t, "first.bin", []byte("hello"))
	require.EqualValues(t, 1, f.usedFiles(t))

	f.setOverrides(t, map[string]any{"quota_files": 1})

	resp, out := f.beginRaw(t, map[string]any{
		"path": "main://", "name": "second.bin", "size": 10, "chunk_size": 4096,
	})
	assert.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode, out)
	assert.Equal(t, "FILE_LIMIT_EXCEEDED", out["code"])
	assert.EqualValues(t, 1, out["limit"])
	assert.EqualValues(t, 1, out["used"])

	// The same request against the name that already exists is allowed.
	code, out := f.begin(t, map[string]any{
		"path": "main://", "name": "first.bin", "size": 10, "chunk_size": 4096,
	})
	assert.Equal(t, http.StatusOK, code, out)
}

// ── the upload window ───────────────────────────────────────────────────────

// A full window answers 429 with a Retry-After, and that Retry-After SHRINKS as
// the ledger row ages towards falling out of the window.
func TestQuota_Begin_UploadRateLimitedAndRetryAfterShrinks(t *testing.T) {
	f := newStagedFixture(t)
	ctx := context.Background()

	code, _ := f.setDefaults(t, map[string]any{"upload_window_hours": 1})
	require.Equal(t, http.StatusOK, code)
	f.setOverrides(t, map[string]any{"quota_upload_bytes": 100})

	// The window is already full.
	require.NoError(t, f.store.InsertUploadLedger(ctx, f.userID, 100, ""))

	resp, out := f.beginRaw(t, map[string]any{
		"path": "main://", "name": "rate.bin", "size": 10, "chunk_size": 4096,
	})
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode, out)
	assert.Equal(t, "UPLOAD_RATE_LIMITED", out["code"])
	header, err := strconv.Atoi(resp.Header.Get("Retry-After"))
	require.NoError(t, err, "Retry-After must be a number of seconds")
	assert.EqualValues(t, header, out["retry_after_seconds"], "header and body agree")
	assert.Greater(t, header, 3500, "a fresh row has nearly the whole window to run")

	// Age the row 55 minutes: it now falls out of the window in ~5 minutes.
	_, err = f.sqlDB.Exec(`UPDATE upload_ledger SET created_at=datetime('now','-55 minutes')`)
	require.NoError(t, err)

	resp, out = f.beginRaw(t, map[string]any{
		"path": "main://", "name": "rate.bin", "size": 10, "chunk_size": 4096,
	})
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode, out)
	aged, err := strconv.Atoi(resp.Header.Get("Retry-After"))
	require.NoError(t, err)
	assert.Less(t, aged, header, "the wait shrinks as the oldest row ages")
	assert.Greater(t, aged, 0)

	// Once the row is outside the window entirely the allowance is back.
	_, err = f.sqlDB.Exec(`UPDATE upload_ledger SET created_at=datetime('now','-90 minutes')`)
	require.NoError(t, err)
	code, out2 := f.begin(t, map[string]any{
		"path": "main://", "name": "rate.bin", "size": 10, "chunk_size": 4096,
	})
	assert.Equal(t, http.StatusOK, code, out2)
}

// A completed commit spends the allowance — and only a completed one.
func TestQuota_Commit_RecordsTheUpload(t *testing.T) {
	f := newStagedFixture(t)
	ctx := context.Background()

	body := []byte("0123456789")
	code, out := f.begin(t, map[string]any{
		"path": "main://", "name": "ledger.bin", "size": len(body), "chunk_size": 4096,
	})
	require.Equal(t, http.StatusOK, code, out)
	id := out["id"].(string)

	sum, _, err := f.store.SumUploadLedger(ctx, f.userID, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	require.Zero(t, sum, "begin alone spends nothing")

	code, _ = f.putChunk(t, id, 0, int64(len(body)), int64(len(body)), body)
	require.Equal(t, http.StatusOK, code)
	code, out = f.commit(t, id)
	require.Equal(t, http.StatusAccepted, code, out)

	sum, _, err = f.store.SumUploadLedger(ctx, f.userID, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	assert.EqualValues(t, len(body), sum)
}

// ── the tri-state ───────────────────────────────────────────────────────────

// -1 is "unlimited for this user" and beats a default that would refuse;
// 0 inherits the default.
func TestQuota_Overrides_MinusOneBeatsDefaultZeroInherits(t *testing.T) {
	f := newStagedFixture(t)

	// An instance default of one file, with the user inheriting it (0).
	code, _ := f.setDefaults(t, map[string]any{"quota_files": 1})
	require.Equal(t, http.StatusOK, code)
	f.uploadMultipart(t, "first.bin", []byte("hello"))

	me := f.quotaMe(t)
	assert.EqualValues(t, 1, me["quota_files"])
	assert.Equal(t, "default", me["sources"].(map[string]any)["files"], "0 means inherit")

	resp, _ := f.beginRaw(t, map[string]any{
		"path": "main://", "name": "second.bin", "size": 10, "chunk_size": 4096,
	})
	require.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode)

	// -1 lifts the ceiling for this user only.
	f.setOverrides(t, map[string]any{"quota_files": -1})
	me = f.quotaMe(t)
	assert.EqualValues(t, 0, me["quota_files"], "resolved: 0 == unlimited")
	assert.Equal(t, true, me["files_unlimited"])
	assert.Equal(t, "user", me["sources"].(map[string]any)["files"])

	code, out := f.begin(t, map[string]any{
		"path": "main://", "name": "second.bin", "size": 10, "chunk_size": 4096,
	})
	assert.Equal(t, http.StatusOK, code, out)
}

// Anything below -1 is not a tri-state value and is refused; a field the body
// does not name is left alone.
func TestQuota_Overrides_RejectBelowMinusOneAndLeaveUnnamedAlone(t *testing.T) {
	f := newStagedFixture(t)

	out := f.setOverrides(t, map[string]any{"quota_bytes": 4096, "quota_files": 7})
	ov := out["overrides"].(map[string]any)
	require.EqualValues(t, 4096, ov["quota_bytes"])
	require.EqualValues(t, 7, ov["quota_files"])

	out = f.setOverrides(t, map[string]any{"quota_files": -1})
	ov = out["overrides"].(map[string]any)
	assert.EqualValues(t, 4096, ov["quota_bytes"], "a field the PATCH did not name is untouched")
	assert.EqualValues(t, -1, ov["quota_files"])

	code, _ := f.patchJSON(t,
		fmt.Sprintf("%s/api/admin/users/%d/quota", f.srv.URL, f.userID),
		map[string]any{"quota_files": -2})
	assert.Equal(t, http.StatusBadRequest, code)
}

// ── the admin endpoints ─────────────────────────────────────────────────────

func TestAdminQuotas_DefaultsRoundTripAndValidate(t *testing.T) {
	f := newStagedFixture(t)

	resp, err := f.client.Get(f.srv.URL + "/api/admin/quotas")
	require.NoError(t, err)
	body := map[string]any{}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	def := body["defaults"].(map[string]any)
	assert.EqualValues(t, 0, def["quota_bytes"], "a fresh install is unlimited")
	assert.EqualValues(t, 24, def["upload_window_hours"])

	code, out := f.setDefaults(t, map[string]any{
		"quota_bytes": 1 << 20, "quota_files": 100,
		"upload_bytes": 1 << 30, "upload_window_hours": 6,
	})
	require.Equal(t, http.StatusOK, code, out)
	def = out["defaults"].(map[string]any)
	assert.EqualValues(t, 1<<20, def["quota_bytes"])
	assert.EqualValues(t, 100, def["quota_files"])
	assert.EqualValues(t, 1<<30, def["upload_bytes"])
	assert.EqualValues(t, 6, def["upload_window_hours"])

	for _, bad := range []map[string]any{
		{"upload_window_hours": 0},
		{"upload_window_hours": 721},
		{"quota_files": -1},
	} {
		code, out = f.setDefaults(t, bad)
		assert.Equal(t, http.StatusBadRequest, code, "%v → %v", bad, out)
	}

	// ⚠ A refused PATCH must change NOTHING, including the fields that were
	// legal — an operator's form and the database disagreeing is worse than a
	// rejected save.
	code, out = f.setDefaults(t, map[string]any{"quota_files": 5, "upload_window_hours": 9000})
	require.Equal(t, http.StatusBadRequest, code, out)
	resp, err = f.client.Get(f.srv.URL + "/api/admin/quotas")
	require.NoError(t, err)
	body = map[string]any{}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	_ = resp.Body.Close()
	assert.EqualValues(t, 100, body["defaults"].(map[string]any)["quota_files"])
}

func TestAdminQuotas_UsersListPagesAndSearches(t *testing.T) {
	f := newStagedFixture(t)
	ctx := context.Background()

	for _, email := range []string{"zoe@x.local", "yan@x.local"} {
		_, err := f.store.CreateUser(ctx, email, "x", "user", "en", "UTC")
		require.NoError(t, err)
	}
	f.setOverrides(t, map[string]any{"quota_files": -1, "quota_bytes": 2048})

	list := func(qs string) map[string]any {
		resp, err := f.client.Get(f.srv.URL + "/api/admin/quotas/users" + qs)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		out := map[string]any{}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}

	all := list("")
	assert.EqualValues(t, 3, all["total"])
	assert.EqualValues(t, 50, all["limit"], "the default page size")
	assert.Len(t, all["users"], 3)

	page := list("?limit=2&offset=2")
	assert.EqualValues(t, 3, page["total"], "total is the count before paging")
	assert.Len(t, page["users"], 1)
	assert.EqualValues(t, 2, page["offset"])

	found := list("?q=ZOE")
	require.EqualValues(t, 1, found["total"])
	row := found["users"].([]any)[0].(map[string]any)
	assert.Equal(t, "zoe@x.local", row["email"])

	// The admin's own row carries the raw overrides AND the resolved values.
	self := list("?q=" + f.adminEml)
	row = self["users"].([]any)[0].(map[string]any)
	assert.EqualValues(t, -1, row["overrides"].(map[string]any)["quota_files"])
	assert.EqualValues(t, 0, row["effective"].(map[string]any)["quota_files"], "-1 resolves to unlimited")
	assert.EqualValues(t, 2048, row["effective"].(map[string]any)["quota_bytes"])
}

// /api/files/quota/me carries every field the client renders.
func TestQuota_Me_CarriesTheExtendedFields(t *testing.T) {
	f := newStagedFixture(t)
	ctx := context.Background()

	f.uploadMultipart(t, "a.bin", []byte("hello"))
	require.NoError(t, f.store.InsertUploadLedger(ctx, f.userID, 42, ""))
	f.setOverrides(t, map[string]any{"quota_files": 9, "quota_upload_bytes": 1000})

	me := f.quotaMe(t)
	assert.EqualValues(t, 1, me["used_files"])
	assert.EqualValues(t, 9, me["quota_files"])
	assert.Equal(t, false, me["files_unlimited"])
	// 5 from the multipart upload above (vfUpload writes one ledger row per
	// file that lands) plus the 42 inserted here.
	assert.EqualValues(t, 47, me["upload_used_bytes"])
	assert.EqualValues(t, 1000, me["upload_quota_bytes"])
	assert.EqualValues(t, 24, me["upload_window_hours"])
	assert.Equal(t, false, me["upload_unlimited"])
	src := me["sources"].(map[string]any)
	assert.Equal(t, "default", src["bytes"])
	assert.Equal(t, "user", src["files"])
	assert.Equal(t, "user", src["upload"])
	// The self endpoint never leaks the raw tri-state: it is an admin concern.
	_, hasOverrides := me["overrides"]
	assert.False(t, hasOverrides)
}

// usedFiles reads the fixture admin's usage_files straight from the DB.
func (f *stagedFixture) usedFiles(t *testing.T) int64 {
	t.Helper()
	n, err := f.store.GetUserFileUsage(context.Background(), f.userID)
	require.NoError(t, err)
	return n
}
