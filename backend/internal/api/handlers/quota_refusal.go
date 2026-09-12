// Package handlers — quota_refusal.go
//
// One place where a quota refusal becomes an HTTP answer, so that every write
// surface refuses in the same words with the same code. Before this there was
// one 413 spelled out by hand at the staged begin and another at vfUpload, and
// two more ceilings were about to be added to both.
//
//	bytes        413 {"error":"quota exceeded","code":"QUOTA_EXCEEDED"}
//	file count   413 {"error":"file limit reached","code":"FILE_LIMIT_EXCEEDED",
//	                  "limit":N,"used":M}
//	upload rate  429 {"error":"upload limit reached","code":"UPLOAD_RATE_LIMITED",
//	                  "retry_after_seconds":S}  + header Retry-After: S
//
// The rate refusal is a 429 and not a 413 on purpose: 413 says "this will
// never fit", and the client's correct reaction is to give up. The rate limit
// says the opposite — the same request succeeds later — and Retry-After says
// when, so a retrying client is told rather than left to guess.
package handlers

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"github.com/brf-tech/filex/backend/internal/metrics"
	"github.com/brf-tech/filex/backend/internal/quota"
)

// countQuotaRefusal increments the guard counter for a quota error, once.
//
// ⚠ It lives at the HTTP mapping rather than inside checkQuota because a
// refusal reaches the wire exactly once, while the check itself is reachable
// from paths that retry or fall through — counting there is how a guard metric
// comes to over-report.
func countQuotaRefusal(err error) {
	var rate quota.ErrUploadRateLimited
	switch {
	case errors.Is(err, quota.ErrQuotaExceeded):
		metrics.GuardRefusals.WithLabelValues(metrics.GuardQuota).Inc()
	case errors.Is(err, quota.ErrFileLimitExceeded):
		metrics.GuardRefusals.WithLabelValues(metrics.GuardFiles).Inc()
	case errors.As(err, &rate):
		metrics.GuardRefusals.WithLabelValues(metrics.GuardUploadRate).Inc()
	}
}

// writeQuotaRefusal answers a quota error and counts it. It returns false when
// err is NOT one of the three refusals, leaving the caller to decide (every
// caller answers 500 — a store that will not read is a server fault).
func writeQuotaRefusal(ctx context.Context, w http.ResponseWriter, svc *quota.Service, userID int64, err error) bool {
	switch {
	case errors.Is(err, quota.ErrQuotaExceeded):
		countQuotaRefusal(err)
		slog.Info("write refused: quota", slog.Int64("user", userID))
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"error": "quota exceeded",
			"code":  "QUOTA_EXCEEDED",
		})
		return true

	case errors.Is(err, quota.ErrFileLimitExceeded):
		countQuotaRefusal(err)
		// The numbers are re-read rather than threaded through the error: the
		// refusal is rare, and a client told "you are at the limit" with no
		// limit and no count cannot render anything useful.
		var limit, used int64
		if lim, lerr := svc.Limits(ctx, userID); lerr == nil {
			limit = lim.Files
		}
		if snap, serr := svc.Get(ctx, userID); serr == nil {
			used = snap.UsedFiles
		}
		slog.Info("write refused: file limit",
			slog.Int64("user", userID), slog.Int64("limit", limit), slog.Int64("used", used))
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"error": "file limit reached",
			"code":  "FILE_LIMIT_EXCEEDED",
			"limit": limit,
			"used":  used,
		})
		return true
	}

	var rate quota.ErrUploadRateLimited
	if errors.As(err, &rate) {
		countQuotaRefusal(err)
		// Rounded UP: a Retry-After that rounds 1.4s down to 1 sends the
		// client back before the allowance has actually grown.
		secs := int64(math.Ceil(rate.RetryAfter.Seconds()))
		if secs < 1 {
			secs = 1
		}
		slog.Info("write refused: upload rate",
			slog.Int64("user", userID), slog.Int64("retry_after", secs))
		w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":               "upload limit reached",
			"code":                "UPLOAD_RATE_LIMITED",
			"retry_after_seconds": secs,
		})
		return true
	}
	return false
}
