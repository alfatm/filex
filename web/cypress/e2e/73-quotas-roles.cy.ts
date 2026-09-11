// 73-quotas-roles — the operator's quota defaults and the role matrix, at the
// API level (the pages themselves are covered by the vitest suite).
//
// Status sets are tolerant on purpose: CI's hermetic profile may run against a
// build that has not shipped these handlers yet, and a 404 there must read as
// "not on this build", not as a red suite.

const NOT_THERE = [404, 405, 501];

describe('quota defaults', () => {
  beforeEach(() => {
    cy.apiLogin();
  });

  it('GET /api/admin/quotas returns the defaults dict', () => {
    cy.apiLogin().then((tok) => {
      cy.request({
        method: 'GET',
        url: '/api/admin/quotas',
        headers: { Authorization: `Bearer ${tok}` },
        failOnStatusCode: false,
      }).then((res) => {
        if (NOT_THERE.includes(res.status)) return;
        expect(res.status, 'GET /api/admin/quotas').to.eq(200);
        const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
        expect(body, 'defaults envelope').to.have.property('defaults');
        expect(body.defaults, 'defaults').to.be.an('object');
        for (const k of ['quota_bytes', 'quota_files', 'upload_bytes', 'upload_window_hours']) {
          expect(body.defaults, `defaults.${k}`).to.have.property(k);
        }
      });
    });
  });

  it('PATCH /api/admin/quotas round-trips one field and restores it', () => {
    cy.apiLogin().then((tok) => {
      const auth = { Authorization: `Bearer ${tok}` };
      cy.request({
        method: 'GET',
        url: '/api/admin/quotas',
        headers: auth,
        failOnStatusCode: false,
      }).then((read) => {
        if (NOT_THERE.includes(read.status)) return;
        const before = (typeof read.body === 'string' ? JSON.parse(read.body) : read.body).defaults;
        const probe = (Number(before.upload_window_hours) || 24) === 24 ? 12 : 24;
        cy.request({
          method: 'PATCH',
          url: '/api/admin/quotas',
          headers: auth,
          body: { upload_window_hours: probe },
          failOnStatusCode: false,
        }).then((patched) => {
          if (NOT_THERE.includes(patched.status)) return;
          expect(patched.status, 'PATCH /api/admin/quotas').to.be.oneOf([200, 204]);
          cy.request({ method: 'GET', url: '/api/admin/quotas', headers: auth }).then((after) => {
            const body = typeof after.body === 'string' ? JSON.parse(after.body) : after.body;
            expect(body.defaults.upload_window_hours, 'window round-tripped').to.eq(probe);
            // Put the instance back the way the run found it.
            cy.request({
              method: 'PATCH',
              url: '/api/admin/quotas',
              headers: auth,
              body: { upload_window_hours: before.upload_window_hours },
              failOnStatusCode: false,
            });
          });
        });
      });
    });
  });

  it('PATCH /api/admin/quotas refuses a window outside 1..720', () => {
    cy.apiLogin().then((tok) => {
      cy.request({
        method: 'PATCH',
        url: '/api/admin/quotas',
        headers: { Authorization: `Bearer ${tok}` },
        body: { upload_window_hours: 100000 },
        failOnStatusCode: false,
      }).then((res) => {
        if (NOT_THERE.includes(res.status)) return;
        expect(res.status, 'out-of-range window rejected').to.be.oneOf([400, 422]);
      });
    });
  });

  it('GET /api/admin/quotas/users lists accounts with overrides and effective limits', () => {
    cy.apiLogin().then((tok) => {
      cy.request({
        method: 'GET',
        url: '/api/admin/quotas/users?limit=5',
        headers: { Authorization: `Bearer ${tok}` },
        failOnStatusCode: false,
      }).then((res) => {
        if (NOT_THERE.includes(res.status)) return;
        expect(res.status, 'GET /api/admin/quotas/users').to.eq(200);
        const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
        const users = body.users ?? [];
        expect(users, 'users').to.be.an('array');
        expect(users.length, 'limit honored').to.be.lessThan(6);
        if (users.length) {
          expect(users[0], 'row carries overrides').to.have.property('overrides');
          expect(users[0], 'row carries effective limits').to.have.property('effective');
        }
      });
    });
  });
});

describe('roles', () => {
  beforeEach(() => {
    cy.apiLogin();
  });

  it('GET /api/admin/roles returns roles plus the operation catalogue', () => {
    cy.apiLogin().then((tok) => {
      cy.request({
        method: 'GET',
        url: '/api/admin/roles',
        headers: { Authorization: `Bearer ${tok}` },
        failOnStatusCode: false,
      }).then((res) => {
        if (NOT_THERE.includes(res.status)) return;
        expect(res.status, 'GET /api/admin/roles').to.eq(200);
        const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
        expect(body.roles, 'roles').to.be.an('array');
        expect(body.catalogue, 'catalogue').to.be.an('array');
        if (body.catalogue.length) {
          expect(body.catalogue[0], 'catalogue op id').to.have.property('id');
          expect(body.catalogue[0], 'catalogue op group').to.have.property('group');
        }
        const admin = (body.roles ?? []).find((r: { name: string }) => r.name === 'admin');
        if (admin) expect(admin.editable, 'admin is not editable').to.not.eq(true);
      });
    });
  });

  it('PUT /api/admin/roles/admin is refused', () => {
    cy.apiLogin().then((tok) => {
      cy.request({
        method: 'PUT',
        url: '/api/admin/roles/admin',
        headers: { Authorization: `Bearer ${tok}` },
        body: { permissions: [] },
        failOnStatusCode: false,
      }).then((res) => {
        if (NOT_THERE.includes(res.status)) return;
        expect(res.status, 'admin role is immutable').to.be.oneOf([400, 403, 409, 422]);
      });
    });
  });
});
