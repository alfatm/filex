// 96-assistant-admin — the AI assistant's operator surface.
//
// What is pinned here is mostly what the API does NOT return. The admin page
// is built on two promises: the stored provider key is never read back, and a
// conversation is never readable by an administrator — only its metadata.
// Both live in the response shapes below, so a future field that broke either
// would fail here rather than in a review.

describe('assistant admin', () => {
  beforeEach(() => {
    cy.apiLogin();
  });

  it('reports the provider configuration without ever returning the key', () => {
    cy.adminGet<Record<string, unknown>>('/api/admin/assistant/provider').then((cfg) => {
      for (const key of ['enabled', 'provider', 'base_url', 'endpoint', 'model', 'turns_per_minute', 'has_key', 'ready', 'providers']) {
        expect(cfg, `provider config carries ${key}`).to.have.property(key);
      }
      expect(cfg, 'the key itself is never in the response').to.not.have.property('api_key');
      expect(JSON.stringify(cfg), 'nothing key-shaped leaks through another field').to.not.match(/sk-[A-Za-z0-9]/);
      expect(cfg.providers, 'the protocols the form may offer').to.be.an('array');
    });
  });

  it('lists conversations as metadata, with no message anywhere in the answer', () => {
    cy.adminGet<{ sessions: Array<Record<string, unknown>> }>('/api/admin/assistant/sessions').then((d) => {
      expect(d.sessions, 'sessions').to.be.an('array');
      for (const row of d.sessions) {
        for (const key of ['id', 'user_id', 'user_email', 'title', 'message_count', 'last_active_at']) {
          expect(row, `row carries ${key}`).to.have.property(key);
        }
        // ⚠ The whole point of the two-table schema: an operator sees how much
        // history exists, never what is in it.
        expect(row, 'no message text').to.not.have.property('messages');
        expect(row, 'no message text').to.not.have.property('content');
      }
    });
  });

  it('has no route that returns somebody else’s conversation', () => {
    cy.adminGet<{ sessions: Array<{ id: string }> }>('/api/admin/assistant/sessions').then((d) => {
      const id = d.sessions[0]?.id;
      if (!id) return; // nothing to ask for on a fresh instance
      const tok = window.sessionStorage.getItem('filex.bearer');
      cy.request({
        method: 'GET',
        url: `/api/admin/assistant/sessions/${id}`,
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        failOnStatusCode: false,
      }).then((res) => {
        expect(res.status, 'reading one conversation as an admin is not a route that exists').to.be.oneOf([404, 405]);
      });
    });
  });
});
