import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { repository } from '@/data';
import type { Credentials, User } from '@/data/types';

/**
 * Who is signed in, asked once and remembered.
 *
 * The router's guard runs on every navigation and the shell must not pay for a round trip each time, so the first
 * answer is kept: `checked` is what says the question has been put, and it is what separates "signed in as nobody"
 * from "not asked yet" — the two look identical in `user` and only one of them may bounce somebody to the form.
 *
 * A failure to REACH the server is deliberately not a sign-out. `check` leaves `checked` false and rethrows
 * nothing: the guard lets the navigation through, the screen behind it shows its own error, and the person keeps
 * whatever they were doing instead of being thrown at a sign-in form by a dropped connection.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const checked = ref(false);
  const pending = ref(false);
  /** Whether the "your session ended" prompt is on screen. */
  const expired = ref(false);
  /** It is raised at most once: every screen keeps making requests, and each of them would raise it again. */
  let announced = false;
  /** One check in flight: a burst of 401s asks `/api/auth/me` once, not once per failed request. */
  let probing = false;

  const signedIn = computed(() => user.value !== null);

  /** Asks the server who this browser is, at most once per answer. Returns whether there is a session. */
  async function check(): Promise<boolean> {
    if (checked.value) return signedIn.value;
    try {
      user.value = await repository.session();
      checked.value = true;
    } catch (error) {
      // Unreachable, not signed out. Left unchecked on purpose so the next navigation asks again.
      console.error('session unavailable', error);
    }
    return signedIn.value;
  }

  /** Rejects with one of the repository's sign-in reasons; the form is what turns those into a sentence. */
  async function signIn(credentials: Credentials): Promise<void> {
    pending.value = true;
    try {
      user.value = await repository.signIn(credentials);
      checked.value = true;
    } finally {
      pending.value = false;
    }
  }

  /**
   * Ends the session and reloads the app onto the sign-in screen.
   *
   * A full navigation rather than a router push: every store in the app holds the previous account's work —
   * listings, uploads in flight, assistant conversations, the settings draft — and a signed-out shell that keeps
   * showing them is both a leak and a screen full of actions the server now answers 401 to. Reloading is the one
   * way to be sure nothing of theirs is left in memory for whoever signs in next on this browser.
   */
  async function signOut(): Promise<void> {
    pending.value = true;
    try {
      await repository.signOut();
    } finally {
      user.value = null;
      pending.value = false;
      window.location.assign(`${import.meta.env.BASE_URL}login`);
    }
  }

  /**
   * A request came back 401. That is a REASON TO ASK, not an answer.
   *
   * filex answers 401 for things that have nothing to do with the cookie — reading a node's permissions or its
   * share state on an item the account may not see is a 401 while the session is perfectly alive — so acting on
   * one directly put "your session has ended" on screen in the middle of a working app. `/api/auth/me` is the
   * only endpoint whose 401 means what it says, so that is what decides, and it is asked once: a screen makes
   * several requests and a lost session fails all of them, but there is one session to ask about.
   *
   * Nothing is signed out here on purpose. Whatever the person was typing is still on screen and still theirs to
   * copy; `reauth` is what leaves the page, and only when they ask for it.
   */
  function noteUnauthorized() {
    if (announced || probing) return;
    probing = true;
    void verify().finally(() => (probing = false));
  }

  async function verify() {
    let who: User | null;
    try {
      who = await repository.session();
    } catch (error) {
      // The server could not be reached at all — the same rule as `check`: unreachable is not signed out.
      console.error('session unavailable', error);
      return;
    }
    user.value = who;
    // Still signed in: that 401 was the endpoint's own answer about what was asked for, and nobody is told.
    if (who) return;
    announced = true;
    expired.value = true;
  }

  /** Dismissed. The prompt does not come back this session — `announced` stays true. */
  function dismissExpired() {
    expired.value = false;
  }

  /**
   * Off to the sign-in form, carrying where they were so signing in resumes it.
   *
   * A full navigation for the same reason `signOut` uses one: the stores still hold the previous session's
   * listings, uploads and conversations, and none of it survives the new sign-in as anything but stale.
   */
  function reauth() {
    const redirect = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`${import.meta.env.BASE_URL}login?redirect=${encodeURIComponent(redirect)}`);
  }

  return { user, checked, pending, expired, signedIn, check, signIn, signOut, noteUnauthorized, dismissExpired, reauth };
});
