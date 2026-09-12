import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../../helpers/auth';

const AUTH_STATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test-results/app-responsive/auth.json',
);

/**
 * The app has no sign-in screen of its own, so the session is minted once here and every project starts with it.
 * Its own state file rather than the live suite's: the two suites run against different servers, and a cookie from
 * a previous `run.mjs app` would point at a port that is no longer listening.
 */
setup('mint a session for the deterministic admin', async ({ request }) => {
  const res = await request.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(res.ok(), `login as ${ADMIN_EMAIL} failed: ${res.status()} ${await res.text()}`).toBeTruthy();

  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
  const state = await request.storageState({ path: AUTH_STATE });
  expect(state.cookies.length, 'the server answered 200 but set no session cookie').toBeGreaterThan(0);
});
