import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../../helpers/auth';

const AUTH_STATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test-results/app-live/auth.json',
);

/**
 * The app has NO login screen — it is the signed-in surface, and the admin SPA is where an account signs in
 * So the session is minted here, once, and every spec starts with it.
 *
 * ⚠ Through the preview server's own origin, not the backend's. `vite preview` proxies `/api`, so the cookie is
 * set for the host the browser will send it back to; a cookie minted straight off the backend's port would carry
 * the same host anyway, but only because both happen to be 127.0.0.1 — going through the proxy makes the suite
 * match what the browser actually does rather than rely on that.
 */
setup('mint a session for the deterministic admin', async ({ request }) => {
  const res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(res.ok(), `login as ${ADMIN_EMAIL} failed: ${res.status()} ${await res.text()}`).toBeTruthy();

  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
  const state = await request.storageState({ path: AUTH_STATE });
  // A storage state with no cookies loads fine and every later spec then fails on a blank shell, which reads like
  // a broken app. Fail here instead, where the message can name the cause.
  expect(state.cookies.length, 'the server answered 200 but set no session cookie').toBeGreaterThan(0);
});
