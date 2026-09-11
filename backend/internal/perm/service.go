package perm

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/brf-tech/filex/backend/internal/db"
)

// ErrUnknownRole is returned when a role name has no row in `roles`.
var ErrUnknownRole = errors.New("perm: unknown role")

// ErrNotEditable is returned for any attempt to edit the admin role.
var ErrNotEditable = errors.New("perm: the admin role is not editable")

// ErrUnknownOp is returned when a write names an operation outside Catalogue.
var ErrUnknownOp = errors.New("perm: unknown operation")

// cacheTTL bounds how stale a permission answer may be.
//
// Short on purpose. Every mutating request asks this question, so the read has
// to be cheap; but an operator who takes `files.delete` away and then watches
// somebody delete a file is entitled to assume the switch is broken. Writes
// through Set invalidate immediately, so the TTL only covers a change made
// behind the service's back (another node, or psql).
const cacheTTL = 15 * time.Second

// Service resolves role → allowed operations, backed by roles.permissions_json.
type Service struct {
	Store db.Store

	mu    sync.RWMutex
	cache map[string]cacheEntry
	ttl   time.Duration
	nowFn func() time.Time
}

type cacheEntry struct {
	ops   []string
	err   error // only ErrUnknownRole is cached; real failures are not
	until time.Time
}

// New constructs a Service over the given store. A nil store is allowed and
// makes every answer fall back to Defaults — the same degrade-don't-block
// stance the ACL resolver takes, so a hand-assembled embedder keeps working.
func New(store db.Store) *Service {
	return &Service{Store: store, cache: map[string]cacheEntry{}, ttl: cacheTTL, nowFn: time.Now}
}

func (s *Service) now() time.Time {
	if s.nowFn != nil {
		return s.nowFn()
	}
	return time.Now()
}

// Permissions returns the EXPANDED operation list for role: the wildcard is
// resolved to the whole catalogue, so a caller never has to know about `*`.
// Order follows Catalogue.
func (s *Service) Permissions(ctx context.Context, role string) ([]string, error) {
	raw, err := s.raw(ctx, role)
	if err != nil {
		return nil, err
	}
	return expand(raw), nil
}

// Allowed reports whether role may perform op. The admin wildcard is always
// true; an unknown role is always false (and no error — a request from an
// account whose role vanished is refused, not 500'd).
func (s *Service) Allowed(ctx context.Context, role, op string) (bool, error) {
	raw, err := s.raw(ctx, role)
	if errors.Is(err, ErrUnknownRole) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, p := range raw {
		if p == Wildcard || p == op {
			return true, nil
		}
	}
	return false, nil
}

// Set replaces the operation list of role. It refuses the admin role (its
// wildcard is the definition of "administrator" — an install that can lock its
// admins out of a permissions screen cannot be recovered through the product),
// refuses an unknown role, refuses any operation outside Catalogue, and drops
// the cache entry so the next request reads the new row.
func (s *Service) Set(ctx context.Context, role string, ops []string) error {
	if role == "admin" {
		return ErrNotEditable
	}
	if s.Store == nil {
		return errors.New("perm: no store")
	}
	// The role must exist. Reading first also means an unknown name is a 400
	// rather than a silent no-op UPDATE.
	if _, err := s.Store.GetRolePermissions(ctx, role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnknownRole
		}
		return err
	}
	clean := make([]string, 0, len(ops))
	seen := map[string]bool{}
	for _, op := range ops {
		if !Known(op) {
			return fmt.Errorf("%w: %q", ErrUnknownOp, op)
		}
		if !seen[op] {
			seen[op] = true
			clean = append(clean, op)
		}
	}
	// Store in catalogue order, not in the order the client happened to send —
	// a diff of two installs' roles table should be about the permissions, not
	// about which checkbox somebody ticked first.
	if err := s.Store.SetRolePermissions(ctx, role, order(clean)); err != nil {
		return err
	}
	s.Invalidate(role)
	return nil
}

// Invalidate drops one role's cached answer ("" drops all of them).
func (s *Service) Invalidate(role string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if role == "" {
		s.cache = map[string]cacheEntry{}
		return
	}
	delete(s.cache, role)
}

// raw returns the stored list for role (possibly containing the wildcard).
func (s *Service) raw(ctx context.Context, role string) ([]string, error) {
	if role == "" {
		return nil, ErrUnknownRole
	}
	s.mu.RLock()
	e, ok := s.cache[role]
	s.mu.RUnlock()
	if ok && s.now().Before(e.until) {
		return e.ops, e.err
	}

	var ops []string
	var err error
	if s.Store == nil {
		// No store: the compiled-in defaults, so a hand-assembled Deps behaves
		// like a fresh install rather than refusing everything.
		if d, known := Defaults[role]; known {
			ops = d
		} else {
			err = ErrUnknownRole
		}
	} else {
		ops, err = s.Store.GetRolePermissions(ctx, role)
		if errors.Is(err, sql.ErrNoRows) {
			ops, err = nil, ErrUnknownRole
		}
	}
	if err != nil && !errors.Is(err, ErrUnknownRole) {
		// A database failure is not an answer — don't cache it, and don't let
		// the caller mistake it for a denial.
		return nil, err
	}
	s.mu.Lock()
	s.cache[role] = cacheEntry{ops: ops, err: err, until: s.now().Add(s.ttl)}
	s.mu.Unlock()
	return ops, err
}

// expand resolves the wildcard to the full catalogue and sorts into catalogue
// order, dropping anything this build no longer enforces.
func expand(raw []string) []string {
	for _, p := range raw {
		if p == Wildcard {
			return AllOps()
		}
	}
	return order(raw)
}

// order filters ops down to catalogue members, in catalogue order.
func order(ops []string) []string {
	have := make(map[string]bool, len(ops))
	for _, p := range ops {
		have[p] = true
	}
	out := make([]string, 0, len(ops))
	for _, o := range Catalogue {
		if have[o.ID] {
			out = append(out, o.ID)
		}
	}
	return out
}
