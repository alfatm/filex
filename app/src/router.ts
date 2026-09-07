import { createRouter, createWebHistory } from 'vue-router';

// Pages are separate chunks, fetched on first navigation.
const HomePage = () => import('./pages/HomePage.vue');
const MyFilesPage = () => import('./pages/MyFilesPage.vue');
const RecentPage = () => import('./pages/RecentPage.vue');
const SearchPage = () => import('./pages/SearchPage.vue');
const SharedPage = () => import('./pages/SharedPage.vue');
const StarredPage = () => import('./pages/StarredPage.vue');
const TrashPage = () => import('./pages/TrashPage.vue');

export const routes = [
  { path: '/', alias: '/home', name: 'home', component: HomePage },
  // `path` is the folder path relative to the storage root, one param segment per folder.
  { path: '/files/:path*', name: 'files', component: MyFilesPage },
  { path: '/shared', name: 'shared', component: SharedPage },
  { path: '/recent', name: 'recent', component: RecentPage },
  { path: '/starred', name: 'starred', component: StarredPage },
  { path: '/trash', name: 'trash', component: TrashPage },
  // One storage for now: its entry is the files root (the sidebar marks it active on every files route).
  { path: '/storage/:id', name: 'storage', redirect: '/files' },
  { path: '/search', name: 'search', component: SearchPage },
] as const;

export default createRouter({
  history: createWebHistory('/app/'),
  routes: [...routes],
});
