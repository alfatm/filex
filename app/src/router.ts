import { createRouter, createWebHistory } from 'vue-router';

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

export const routes = [
  { path: '/', alias: '/home', name: 'home', component: HomePage },
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
] as const;

export default createRouter({
  history: createWebHistory('/app/'),
  routes: [...routes],
});
