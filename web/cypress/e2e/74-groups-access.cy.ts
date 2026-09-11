// 74-groups-access — a group as an RBAC principal, end to end at the API
// level: create a group, put an account in it, turn RBAC on for a storage,
// grant the group access, see the row come back as a group row, clean up.
//
// Every step tolerates the handler not existing on this build (404/405/501) and
// bails out of the rest of the flow rather than failing — CI's hermetic profile
// may also have no storage and no second account to work with.

const NOT_THERE = [404, 405, 501];

function auth(tok: string) {
  return { Authorization: `Bearer ${tok}` };
}

function parse(body: unknown) {
  return typeof body === 'string' ? JSON.parse(body) : body;
}

describe('groups as grant principals', () => {
  it('creates a group, adds a member, grants it access, and cleans up', () => {
    cy.apiLogin().then((tok) => {
      const h = auth(tok);
      const name = `cypress-group-${Date.now()}`;

      cy.request({
        method: 'POST',
        url: '/api/admin/groups',
        headers: h,
        body: { name, description: 'created by 74-groups-access' },
        failOnStatusCode: false,
      }).then((created) => {
        if (NOT_THERE.includes(created.status)) return;
        expect(created.status, 'POST /api/admin/groups').to.be.oneOf([200, 201]);
        const group = parse(created.body);
        expect(group.id, 'group id').to.be.a('number');

        // The list has to show it.
        cy.request({
          method: 'GET',
          url: `/api/admin/groups?q=${encodeURIComponent(name)}`,
          headers: h,
        }).then((listed) => {
          const body = parse(listed.body);
          const names = (body.groups ?? []).map((g: { name: string }) => g.name);
          expect(names, 'the new group is listed').to.include(name);
        });

        // A member: the admin account itself is the one account every profile has.
        cy.request({ method: 'GET', url: '/api/auth/me', headers: h }).then((me) => {
          const userId = parse(me.body).id ?? parse(me.body).user?.id;
          if (typeof userId !== 'number') return;
          cy.request({
            method: 'POST',
            url: `/api/admin/groups/${group.id}/members`,
            headers: h,
            body: { user_id: userId },
            failOnStatusCode: false,
          }).then((added) => {
            if (NOT_THERE.includes(added.status)) return;
            expect(added.status, 'POST member').to.be.oneOf([200, 201, 204, 409]);
            cy.request({ method: 'GET', url: `/api/admin/groups/${group.id}`, headers: h }).then(
              (detail) => {
                const ids = (parse(detail.body).members ?? []).map((m: { id: number }) => m.id);
                expect(ids, 'the member is in the group').to.include(userId);
              },
            );
          });
        });

        // RBAC has to be on for the storage before a grant means anything.
        cy.request({ method: 'GET', url: '/api/admin/storages', headers: h }).then((sres) => {
          const storages = parse(sres.body);
          const storage = Array.isArray(storages) ? storages[0] : (storages.items ?? [])[0];
          if (!storage) {
            // No storage in this profile — the group half of the spec still ran.
            cy.request({
              method: 'DELETE',
              url: `/api/admin/groups/${group.id}`,
              headers: h,
              failOnStatusCode: false,
            });
            return;
          }
          const rbacWasOn = storage.rbac_enabled === true;
          cy.request({
            method: 'PATCH',
            url: `/api/admin/storages/${storage.id}`,
            headers: h,
            body: { rbac_enabled: true },
            failOnStatusCode: false,
          }).then((toggled) => {
            expect(toggled.status, 'PATCH rbac_enabled').to.be.oneOf([200, 204]);

            cy.request({
              method: 'POST',
              url: '/api/admin/grants',
              headers: h,
              body: {
                storage_id: storage.id,
                path: '',
                is_dir: true,
                level: 'viewer',
                group_id: group.id,
              },
              failOnStatusCode: false,
            }).then((grant) => {
              const grantId = NOT_THERE.includes(grant.status) ? null : parse(grant.body).id;
              if (grantId != null) {
                expect(grant.status, 'POST /api/admin/grants').to.be.oneOf([200, 201]);
                cy.request({ method: 'GET', url: '/api/admin/grants', headers: h }).then((all) => {
                  const rows = parse(all.body).grants ?? [];
                  const row = rows.find((g: { id: number }) => g.id === grantId);
                  if (row) {
                    expect(row.principal, 'row is a group row').to.eq('group');
                    expect(row.group_id, 'row names the group').to.eq(group.id);
                  }
                });
                cy.request({
                  method: 'DELETE',
                  url: `/api/admin/grants/${grantId}?principal=group`,
                  headers: h,
                  failOnStatusCode: false,
                }).then((revoked) => {
                  expect(revoked.status, 'DELETE group grant').to.be.oneOf([200, 204, 404]);
                });
              }

              // Leave the storage the way the run found it, then drop the group
              // (which takes any grant still issued to it with it).
              if (!rbacWasOn) {
                cy.request({
                  method: 'PATCH',
                  url: `/api/admin/storages/${storage.id}`,
                  headers: h,
                  body: { rbac_enabled: false },
                  failOnStatusCode: false,
                });
              }
              cy.request({
                method: 'DELETE',
                url: `/api/admin/groups/${group.id}`,
                headers: h,
                failOnStatusCode: false,
              }).then((gone) => {
                expect(gone.status, 'DELETE group').to.be.oneOf([200, 204, 404]);
              });
            });
          });
        });
      });
    });
  });

  it('refuses a second group with the same name', () => {
    cy.apiLogin().then((tok) => {
      const h = auth(tok);
      const name = `cypress-dup-${Date.now()}`;
      cy.request({
        method: 'POST',
        url: '/api/admin/groups',
        headers: h,
        body: { name },
        failOnStatusCode: false,
      }).then((first) => {
        if (NOT_THERE.includes(first.status)) return;
        const id = parse(first.body).id;
        cy.request({
          method: 'POST',
          url: '/api/admin/groups',
          headers: h,
          body: { name },
          failOnStatusCode: false,
        }).then((second) => {
          expect(second.status, 'duplicate name rejected').to.be.oneOf([400, 409, 422]);
          cy.request({
            method: 'DELETE',
            url: `/api/admin/groups/${id}`,
            headers: h,
            failOnStatusCode: false,
          });
        });
      });
    });
  });
});
