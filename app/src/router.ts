import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth';

// Pages are separate chunks, fetched on first navigation.
const HomePage = () => import('./pages/HomePage.vue');
const MyFilesPage = () => import('./pages/MyFilesPage.vue');
const RecentPage = () => import('./pages/RecentPage.vue');
const SearchPage = () => import('./pages/SearchPage.vue');
const SharedPage = () => import('./pages/SharedPage.vue');
const StarredPage = () => import('./pages/StarredPage.vue');
const TrashPage = () => import('./pages/TrashPage.vue');
const ConnectPage = () => import('./pages/ConnectPage.vue');
const ApiKeysPage = () => import('./pages/ApiKeysPage.vue');
const LoginPage = () => import('./pages/LoginPage.vue');
const NotFoundPage = () => import('./pages/NotFoundPage.vue');

export const routes = [
  { path: '/', alias: '/home', name: 'home', component: HomePage },
  // The one address reachable without a session; `public` is what the guard below reads, so a screen is guarded
  // by being listed here rather than by remembering to guard it.
  { path: '/login', name: 'login', component: LoginPage, meta: { public: true } },
  // `path` is the folder path relative to the storage root, one param segment per folder.
  { path: '/files/:path*', name: 'files', component: MyFilesPage },
  { path: '/shared', name: 'shared', component: SharedPage },
  { path: '/recent', name: 'recent', component: RecentPage },
  { path: '/starred', name: 'starred', component: StarredPage },
  { path: '/trash', name: 'trash', component: TrashPage },
  // The drive's own entry: its root on the files route, where the drive is the first path segment.
  { path: '/storage/:id', name: 'storage', redirect: (to: { params: Record<string, unknown> }) => `/files/${to.params.id}` },
  { path: '/search', name: 'search', component: SearchPage },
  // The two connection screens. Both mount shared components that talk to the server directly, so the sidebar
  // only links them when there is one (see `Capabilities.connections`).
  { path: '/connect', name: 'connect', component: ConnectPage },
  { path: '/api-keys', name: 'apiKeys', component: ApiKeysPage },
  // Last, so every route above wins: an address this app has no screen for says so instead of drawing the shell
  // around an empty column.
  { path: '/:pathMatch(.*)*', name: 'notFound', component: NotFoundPage },
] as const;

const router = createRouter({
  // Read from Vite's `base` rather than repeated here: the two must agree, and a literal is how they stop
  // agreeing. See app/vite.config.ts.
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [...routes],
});

/**
 * The session gate.
 *
 * It runs before every navigation and asks the server once (the store caches the answer), because a browser that
 * still holds a cookie and a browser that never had one are indistinguishable from inside the page — filex's
 * session cookie is HttpOnly, which is what makes this a request rather than a check.
 *
 * Two rules, and no third: a visitor with no session may only be on the sign-in screen, and somebody who has one
 * has no business there. `redirect` carries where they were headed, so signing in resumes the navigation instead
 * of dumping everybody on Home.
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const signedIn = await auth.check();
  // The server could not be reached at all: the store stays unchecked and nobody is bounced. The page behind this
  // shows its own "could not load", which is the truth, where a sign-in form would have been a guess.
  if (!auth.checked) return true;
  if (to.meta.public) return signedIn ? { name: 'home' } : true;
  return signedIn ? true : { name: 'login', query: { redirect: to.fullPath } };
});

export default router;
