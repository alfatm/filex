package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/e2e" /* wiring:e2 */
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/search"
	"github.com/brf-tech/filex/backend/internal/tenant"
)

// Search handles /api/files/search.
type Search struct {
	Index *search.Index
	Store db.Store
	ACL   *acl.Resolver
}

// NewSearch constructs a Search handler.
func NewSearch(idx *search.Index, store db.Store) *Search {
	return &Search{Index: idx, Store: store}
}

// AttachACL wires the RBAC resolver so search results are filtered to the
// paths the caller may see (prevents cross-user enumeration via search).
func (h *Search) AttachACL(r *acl.Resolver) { h.ACL = r }

// tagFilterMax caps how many nodes ONE tag contributes to a filter.
//
// The filter is applied inside the index as a document-ID set, which is
// exact and lets `limit` count filtered results — but the set has to be
// materialised first. 10k nodes per tag is far past any hand-applied
// tag and keeps a runaway tag from turning one search into a
// ten-thousand-clause boolean query. A tag larger than this is truncated
// newest-first (the order ListNodesByTag returns), which is stated in
// docs/SEARCH.md rather than silently absorbed.
const tagFilterMax = 10000

// resolveTagFilter turns the parsed `tag:` / `-tag:` tokens into the
// node-ID sets the index filters on, plus the include-set nodes
// themselves (so a bare `tag:x` needs no second round trip).
//
// Several tags AND: a filter narrows. A tag nobody has ever applied
// resolves to an empty include set, and an empty include set with
// Restrict set means "no results" — never "ignore the filter", which
// would answer a typo'd tag with the entire storage.
func resolveTagFilter(ctx context.Context, store db.Store, p search.Parsed) (*search.Filter, []*model.Node, error) {
	if !p.HasTagFilter() {
		return nil, nil, nil
	}
	f := &search.Filter{}
	var included []*model.Node
	for i, tag := range p.Tags {
		nodes, err := store.ListNodesByTag(ctx, tag, tagFilterMax)
		if err != nil {
			return nil, nil, err
		}
		if i == 0 {
			f.Restrict = true
			included = nodes
			continue
		}
		keep := map[int64]bool{}
		for _, n := range nodes {
			keep[n.ID] = true
		}
		narrowed := included[:0]
		for _, n := range included {
			if keep[n.ID] {
				narrowed = append(narrowed, n)
			}
		}
		included = narrowed
	}
	for _, n := range included {
		f.IncludeIDs = append(f.IncludeIDs, n.ID)
	}
	for _, tag := range p.ExcludeTags {
		nodes, err := store.ListNodesByTag(ctx, tag, tagFilterMax)
		if err != nil {
			return nil, nil, err
		}
		for _, n := range nodes {
			f.ExcludeIDs = append(f.ExcludeIDs, n.ID)
		}
	}
	return f, included, nil
}

// tagScopeNodes answers the "Tags" scope: every node carrying a tag the typed
// text names.
//
// The text DESCRIBES a tag here rather than naming one exactly, so `des` finds
// everything tagged `design` — the way a search box is expected to behave, and
// what the form's own demo does. The `tag:` operator stays exact: it names one
// tag, and a filter that guessed would narrow to the wrong set. Empty text is
// every tagged node, which is what the chip means on its own.
func tagScopeNodes(ctx context.Context, store db.Store, text string) ([]*model.Node, error) {
	// A fully quoted query is the form's "whole phrase" box; the quotes are
	// its way of saying "these words, adjacent", not part of the tag.
	if phrase, quoted := search.QuotedPhrase(text); quoted {
		text = phrase
	}
	needle := strings.ToLower(strings.TrimSpace(text))
	tags, err := store.ListAllTags(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[int64]bool{}
	var out []*model.Node
	for _, tag := range tags {
		if needle != "" && !strings.Contains(tag, needle) {
			continue
		}
		nodes, err := store.ListNodesByTag(ctx, tag, tagFilterMax)
		if err != nil {
			return nil, err
		}
		for _, n := range nodes {
			if seen[n.ID] {
				continue
			}
			seen[n.ID] = true
			out = append(out, n)
		}
	}
	return out, nil
}

// tagFilterAccepts applies a resolved filter to one node ID — the SQL
// LIKE path, where there is no index to push the filter into.
func tagFilterAccepts(f *search.Filter, id int64) bool {
	if f == nil {
		return true
	}
	for _, ex := range f.ExcludeIDs {
		if ex == id {
			return false
		}
	}
	if !f.Restrict {
		return true
	}
	for _, in := range f.IncludeIDs {
		if in == id {
			return true
		}
	}
	return false
}

// resolveFacetFilter turns the request's facets into the id set the index may
// return from. Nil means "no facets asked for", which is not the same as an
// empty set: an empty set is a filter that matched nothing, and the search
// honours it by answering nothing.
func resolveFacetFilter(ctx context.Context, store db.Store, storageID int64, f db.NodeFacets) ([]int64, bool, error) {
	if !f.Any() {
		return nil, false, nil
	}
	if store == nil {
		return nil, false, nil
	}
	// The facet query is per storage, and a client that addresses drives by name
	// — which the end-user app does, because that is what every other endpoint
	// takes — cannot name a numeric one. So an unscoped search asks each drive
	// and unions the answers rather than giving up on the filter.
	//
	// Widening the CANDIDATE set across drives the caller cannot see is safe:
	// the RBAC pass at the end of Search drops those hits anyway, and it is the
	// only thing standing between any search and a cross-user leak.
	storages := []int64{storageID}
	if storageID == 0 {
		all, err := store.ListEnabledStorages(ctx)
		if err != nil {
			return nil, false, err
		}
		storages = storages[:0]
		for _, st := range all {
			storages = append(storages, st.ID)
		}
	}
	ids := []int64{}
	truncated := false
	for _, id := range storages {
		batch, err := store.ListNodeIDsMatching(ctx, id, f, facetIDCeiling)
		if err != nil {
			return nil, false, err
		}
		if len(batch) >= facetIDCeiling {
			truncated = true
		}
		ids = append(ids, batch...)
	}
	return ids, truncated, nil
}

// facetIDCeiling mirrors the store's own cap; asking for exactly it is how the
// caller learns the set was truncated.
const facetIDCeiling = 10000

// intersectFilter narrows an existing restriction to `ids`, or creates one.
func intersectFilter(f *search.Filter, ids []int64) *search.Filter {
	keep := make(map[int64]bool, len(ids))
	for _, id := range ids {
		keep[id] = true
	}
	if f == nil || !f.Restrict {
		out := &search.Filter{Restrict: true, IncludeIDs: ids}
		if f != nil {
			out.ExcludeIDs = f.ExcludeIDs
		}
		return out
	}
	narrowed := make([]int64, 0, len(f.IncludeIDs))
	for _, id := range f.IncludeIDs {
		if keep[id] {
			narrowed = append(narrowed, id)
		}
	}
	f.IncludeIDs = narrowed
	return f
}

// keepMatching narrows the nodes a bare `tag:` listing answers with.
func keepMatching(nodes []*model.Node, f db.NodeFacets) []*model.Node {
	out := nodes[:0]
	for _, n := range nodes {
		if matchesFacets(n, f) {
			out = append(out, n)
		}
	}
	return out
}

// matchesFacets is the exact predicate, over a node row rather than an id set.
// It is what makes the answer right on the paths that never consult the index,
// and what makes a truncated id set harmless for the hits that did come back.
// The predicate itself is NodeFacets.Matches, next to the SQL it mirrors.
func matchesFacets(n *model.Node, f db.NodeFacets) bool { return f.Matches(n) }

// sortByRank puts fallback rows in the same tier order the index path
// uses. Without it an index-less install would answer the same query in
// a different order — `ORDER BY name` — and "exact matches rank first"
// would be true on one deployment and false on the next.
//
// The plan carries the prepared query, so the subsequence scorer runs
// once per row rather than once per comparison, and the shorter path
// wins a tie exactly as it does on the index path.
func sortByRank(results []searchResult, plan search.Fallback) {
	sort.SliceStable(results, func(a, b int) bool {
		ra := plan.Rank(results[a].Name, results[a].Path)
		rb := plan.Rank(results[b].Name, results[b].Path)
		if ra != rb {
			return ra < rb
		}
		if len(results[a].Path) != len(results[b].Path) {
			return len(results[a].Path) < len(results[b].Path)
		}
		return results[a].Name < results[b].Name
	})
}

type searchRequest struct {
	StorageID int64  `json:"storage_id"`
	Query     string `json:"query"`
	Limit     int    `json:"limit"`
	// Scope selects the fields consulted: "name" | "content" | "all"
	// (default all — name hits ranked first, so pre-v0.2 clients see the
	// same ordering they always did, plus content hits after).
	Scope string `json:"scope"`

	// ── facets ──
	//
	// The properties the full-text index cannot answer for: its documents
	// carry a name, a path, a mime and a type, and nothing else. They are
	// resolved against the node table and applied as a restriction on which
	// documents the index may return — the same mechanism `tag:` uses.
	//
	// Before them, a client asking for "report, modified this week" got the
	// first N hits for "report" and threw away the ones outside the window:
	// if the three files it wanted ranked 200th, it saw nothing and could not
	// tell that from "there are none".

	// PathPrefix confines the search to one subtree, storage-relative.
	PathPrefix string `json:"path_prefix,omitempty"`
	// Exts are extensions without the dot ("md","pdf"). Extensions rather than
	// a type-group name on purpose: which extensions count as "documents" is
	// the client's vocabulary, and a second copy of it here is a second copy to
	// keep in step.
	Exts []string `json:"ext,omitempty"`
	// ModifiedAfter is epoch milliseconds; 0 means no window.
	ModifiedAfter int64 `json:"modified_after,omitempty"`
	SizeMin       int64 `json:"size_min,omitempty"`
	// SizeMax 0 means no ceiling — a search for files of at most zero bytes is
	// not a thing anyone asks for, and treating it as "no ceiling" is what lets
	// the field be omitted.
	SizeMax int64 `json:"size_max,omitempty"`
	OwnerID int64 `json:"owner_id,omitempty"`
	// DirsOnly asks for FOLDERS and nothing else. The destination picker needs
	// it: its tree loads one level at a time, so without a way to ask the server
	// "which folders on this drive are called that", its filter box could only
	// search the levels somebody had already expanded — which is the same as
	// not having one.
	DirsOnly bool `json:"dirs_only,omitempty"`
	// SharedOnly is the form's "Search in → Shared files": only the nodes the
	// caller has published a link to. A facet rather than a scope — it says
	// WHICH files may answer, not which of their fields are read.
	SharedOnly bool `json:"shared_only,omitempty"`
}

// facets turns the request's filter fields into the store's query shape.
func (req searchRequest) facets() db.NodeFacets {
	f := db.NodeFacets{Exts: req.Exts, SharedOnly: req.SharedOnly}
	// Rooted and without a trailing slash, the shape nodes.path is stored in and
	// the shape the store's doc comment asks for. It was taken as given, so a
	// client sending "Docs" or "/Docs/" — the same folder by any reading — got
	// an empty answer with no sign that its filter, rather than its query, was
	// what emptied it.
	if prefix := strings.TrimSpace(req.PathPrefix); prefix != "" {
		f.PathPrefix = "/" + strings.TrimLeft(path.Clean("/"+prefix), "/")
	}
	// A filter on extension or size is a filter for files: a folder has no
	// extension and its size is a rollup. A date or an owner keeps folders.
	f.FilesOnly = len(req.Exts) > 0 || req.SizeMin > 0 || req.SizeMax > 0
	// An explicit "folders only" wins over the implication: asking for folders
	// AND for an extension is a contradiction, and answering it with nothing is
	// more honest than picking one half.
	if req.DirsOnly {
		f.DirsOnly, f.FilesOnly = true, false
	}
	if req.ModifiedAfter > 0 {
		t := time.UnixMilli(req.ModifiedAfter).UTC()
		f.ModifiedAfter = &t
	}
	if req.SizeMin > 0 {
		v := req.SizeMin
		f.SizeMin = &v
	}
	if req.SizeMax > 0 {
		v := req.SizeMax
		f.SizeMax = &v
	}
	if req.OwnerID > 0 {
		v := req.OwnerID
		f.OwnerID = &v
	}
	return f
}

// searchResult is one hit in the response: the node row plus the v0.2
// content-search additions. Embedding keeps the wire shape backward
// compatible — old clients simply ignore snippet/matched.
type searchResult struct {
	*model.Node
	// Snippet is a short plain-text fragment around a content match with
	// the matched terms wrapped in « » ("" for name-only hits, never HTML).
	Snippet string `json:"snippet"`
	// Matched reports which side(s) hit: "name" | "content" | "both".
	Matched string `json:"matched"`
}

// Search returns up to N matching nodes.
//
// Strategy: try Bleve first; on miss/empty, fall back to SQL LIKE on the
// `nodes.name` column.
//
// Accepts both POST {query, storage_id, limit} (canonical) and
// GET ?q=…&storage_id=…&limit=… (admin SPA's toolbar search). The GET
// form lets the SFC degrade gracefully when the embedder hasn't wired
// the POST flow.
func (h *Search) Search(w http.ResponseWriter, r *http.Request) {
	var req searchRequest
	if r.Method == http.MethodGet {
		q := r.URL.Query()
		req.Query = q.Get("q")
		if req.Query == "" {
			req.Query = q.Get("query")
		}
		if v := q.Get("storage_id"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				req.StorageID = n
			}
		}
		if v := q.Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				req.Limit = n
			}
		}
		req.Scope = q.Get("scope")
		req.SharedOnly = q.Get("shared_only") == "1" || q.Get("shared_only") == "true"
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
			return
		}
	}
	if req.Limit <= 0 {
		req.Limit = 50
	}
	sc := search.ParseScope(req.Scope)
	// `tag:` is a FILTER, not a search term (issue #15). It is parsed out
	// of the query string here and resolved against the database, which
	// is the only place tags are current — a tag copied into the search
	// document would go stale the moment somebody re-tagged a file
	// without touching it.
	parsed := search.ParseQuery(req.Query)
	tagFilter, tagged, err := resolveTagFilter(r.Context(), h.Store, parsed)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	facets := req.facets()
	facetIDs, facetTruncated, err := resolveFacetFilter(r.Context(), h.Store, req.StorageID, facets)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Two restrictions on the same axis. A tag filter and a facet filter both
	// say "only these documents", so the search sees their intersection —
	// narrowing twice, never widening.
	if facetIDs != nil {
		tagFilter = intersectFilter(tagFilter, facetIDs)
		tagged = keepMatching(tagged, facets)
	}

	results := []searchResult{}
	switch {
	case sc == search.ScopeTag:
		// The "Tags" chip: the text names a TAG, not a file. Tags are never in
		// the index — they live in node_meta and change without the node being
		// re-indexed — so this is a listing resolved against the database, the
		// same shape a bare `tag:x` already has, and it never reads a filename
		// or a file's contents. Before it, choosing "Tags" searched every field
		// there is.
		byTag, terr := tagScopeNodes(r.Context(), h.Store, parsed.Text)
		if terr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": terr.Error()})
			return
		}
		for _, n := range byTag {
			if req.StorageID != 0 && n.StorageID != req.StorageID {
				continue
			}
			/* wiring:e2 — the marker file stays hidden in name search too */
			if n.Name == e2e.MarkerName {
				continue
			}
			// Chip tags and facets narrow this listing the way they narrow the
			// LIKE fallback: there is no index to push the restriction into.
			if !tagFilterAccepts(tagFilter, n.ID) {
				continue
			}
			results = append(results, searchResult{Node: n, Matched: search.MatchedName})
			if len(results) > req.Limit {
				break
			}
		}
	case parsed.HasTagFilter() && parsed.Text == "":
		// A bare `tag:x` is a listing, not a search: there is no text to
		// score, so the tagged nodes ARE the answer (newest first, the
		// order ListNodesByTag already returns them in).
		for _, n := range tagged {
			if req.StorageID != 0 && n.StorageID != req.StorageID {
				continue
			}
			/* wiring:e2 — the marker file stays hidden in name search too */
			if n.Name == e2e.MarkerName {
				continue
			}
			results = append(results, searchResult{Node: n, Matched: search.MatchedName})
			// One past the limit, deliberately: it is the difference between
			// knowing there is more and guessing it from a full page.
			if len(results) > req.Limit {
				break
			}
		}
	case h.Index != nil:
		hits := h.Index.SafeSearchFiltered(r.Context(), parsed.Text, req.Limit+1, sc, tagFilter)
		for _, hit := range hits {
			n, err := h.Store.GetNode(r.Context(), hit.NodeID)
			if err == nil && (req.StorageID == 0 || n.StorageID == req.StorageID) {
				/* wiring:e2 — the marker file stays hidden in name search too */
				if n.Name == e2e.MarkerName {
					continue
				}
				results = append(results, searchResult{Node: n, Snippet: hit.Snippet, Matched: hit.Matched})
			}
		}
	}
	// SQL LIKE fallback — name-only by nature, so a content-scoped query
	// never falls back (an index-less install has no content to search).
	//
	// It stays gated on a non-zero storage_id: an unscoped query the
	// index cannot answer would otherwise LIKE-scan every mount in the
	// deployment. That gate is deliberate and predates this change; it is
	// documented in docs/SEARCH.md and left alone here.
	if len(results) == 0 && req.StorageID != 0 && parsed.Text != "" &&
		sc != search.ScopeContent && sc != search.ScopeTag {
		plan := search.PlanFallback(parsed.Text)
		fallback, err := h.Store.SearchNodes(r.Context(), req.StorageID, plan.Like, req.Limit*search.FallbackOverFetch)
		if err == nil {
			for _, n := range fallback {
				/* wiring:e2 — the marker file stays hidden in name search too */
				if n.Name == e2e.MarkerName {
					continue
				}
				if !plan.Accepts(n.Name, n.Path) || !tagFilterAccepts(tagFilter, n.ID) {
					continue
				}
				results = append(results, searchResult{Node: n, Matched: search.MatchedName})
				if len(results) > req.Limit {
					break
				}
			}
			sortByRank(results, plan)
		}
	}
	// `capped` is the honest half of a question this endpoint cannot answer.
	//
	// A TRUE total would mean running the whole pipeline over the whole drive:
	// the index over-fetches candidates, the scorer drops half-matches, and the
	// facet, tenant and RBAC passes below drop more. Counting all of that is
	// the work the limit exists to avoid.
	//
	// What is knowable is whether the answer was cut off, and that is worth
	// saying: a client showing "100 matching items" over a search that stopped
	// at a hundred is stating a total it was never given. With this it can say
	// "100+", which is true. The extra row is dropped here rather than sent.
	capped := len(results) > req.Limit
	if capped {
		results = results[:req.Limit]
	}
	// The index restriction covers the branch that consults the index. The bare
	// `tag:` listing and the SQL LIKE fallback do not go through it at all, and
	// a facet that quietly does nothing on an index-less install is worse than
	// one that is refused — so the predicate is applied to the results too.
	// It is also the belt to the index's braces: the restriction was built from
	// a possibly-truncated id set, this is exact over what came back.
	if facets.Any() {
		kept := results[:0]
		for _, res := range results {
			if matchesFacets(res.Node, facets) {
				kept = append(kept, res)
			}
		}
		results = kept
	}

	// "Shared files" is exact over what came back, for the same reason the
	// facet predicate above is applied twice: the index restriction was built
	// from a possibly-truncated id set, and two of the three branches never
	// consult the index at all. One query for the whole page, like every other
	// listing that answers this question.
	if facets.SharedOnly {
		nodes := make([]*model.Node, 0, len(results))
		for _, res := range results {
			nodes = append(nodes, res.Node)
		}
		attachShared(r.Context(), h.Store, nodes)
		kept := results[:0]
		for _, res := range results {
			if res.Shared {
				kept = append(kept, res)
			}
		}
		results = kept
	}

	// Multi-tenant: drop hits in storages outside the caller's tenant. This is
	// the file-data (layer-1) confinement — an unfiltered search is the classic
	// cross-tenant leak (content, not just a name). No-op unless a scope is set.
	if scope, ok := tenant.FromContext(r.Context()); ok {
		kept := results[:0]
		for _, res := range results {
			if scope.CanAccessStorage(res.StorageID) {
				kept = append(kept, res)
			}
		}
		results = kept
	}

	// RBAC: drop hits the caller can't see (per-storage grants; cached).
	// Snippets ride on the hit, so a dropped hit drops its snippet too —
	// content search can never leak text the caller couldn't browse to.
	if h.ACL != nil {
		user := auth.UserFrom(r.Context())
		cache := map[int64]*acl.Set{}
		kept := results[:0]
		for _, res := range results {
			set, ok := cache[res.StorageID]
			if !ok {
				st, _ := h.Store.GetStorage(r.Context(), res.StorageID)
				set, _ = h.ACL.LoadSet(r.Context(), user, st)
				cache[res.StorageID] = set
			}
			if set == nil || set.CanSee(res.Path) {
				kept = append(kept, res)
			}
		}
		results = kept
	}
	// A hit carries only a numeric storage_id, and a client in multi-storage
	// mode cannot build the `<name>://<path>` it needs to open one — the same
	// dead-row problem the starred and recently-opened listings already fixed
	// this way (see model.Node.Storage).
	nodes := make([]*model.Node, len(results))
	for i := range results {
		nodes[i] = results[i].Node
	}
	attachStorageNames(r.Context(), h.Store, nodes)
	// The thumbnail state too, so a hit's tile can show the cached preview
	// rather than fetching the original.
	attachThumbs(r.Context(), h.Store, nodes)
	// And the owner's NAME, for the same reason: a hit carries owner_id and
	// nothing to print it as, so the results list named the caller as the owner
	// of every file it found, on a shared drive included.
	attachOwnerNames(r.Context(), h.Store, nodes)
	out := map[string]any{"results": results, "capped": capped}
	if facetTruncated {
		// Said out loud rather than absorbed: past the ceiling the facet set is
		// a sample, so a hit outside it cannot be found however well it matches.
		out["facets_truncated"] = true
	}
	writeJSON(w, http.StatusOK, out)
}
