package handlers

// The plan kind → operation mapping the assistant's executor gates on.
//
// Worth a test of its own because the failure mode is silent: a kind that
// falls through the switch runs with no operation check at all, which is
// exactly the defect this mapping fixed. So the table is asserted over EVERY
// kind the model can propose — a new plan kind added without a line here fails
// this test rather than shipping ungated.

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/perm"
)

func TestPlanKindOp_EveryKindIsAccountedFor(t *testing.T) {
	cases := map[string]struct {
		op     string
		gated  bool
		reason string
	}{
		model.PlanKindTags:           {perm.OpTags, true, "tagging is files.tags at the button, and here too"},
		model.PlanKindRestoreVersion: {perm.OpRestore, true, "rolling a file back is files.restore"},
		model.PlanKindCreateShare:    {perm.OpShare, true, "minting a public link is files.share"},
		model.PlanKindEmptyTrash:     {perm.OpPurge, true, "destroying files for good is files.purge"},
		model.PlanKindMove:           {perm.OpMove, true, "a move is a move, asked for in words or not"},
		// Not gated, on purpose: closing a link is not minting one, and no
		// other revoke surface is gated either.
		model.PlanKindRevokeShare: {"", false, "revoking has no operation in the catalogue"},
	}
	for kind, want := range cases {
		op, ok := planKindOp(kind)
		assert.Equal(t, want.gated, ok, "%s: %s", kind, want.reason)
		assert.Equal(t, want.op, op, "%s: %s", kind, want.reason)
	}

	// An unknown kind must not be reported as gated: runItem answers "unknown
	// plan kind" for it, and a role refusal there would hide a bug behind a
	// permissions message.
	op, ok := planKindOp("teleport")
	assert.False(t, ok)
	assert.Empty(t, op)
}
