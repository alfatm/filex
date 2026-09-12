import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
import { setUnauthorizedHandler } from './data/http/client';
import { installErrorSink } from './lib/errors';
import router from './router';
import { useAuthStore } from './stores/auth';
import { i18n } from './i18n';

import './design/main.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(i18n);
// After the plugins: the sink reaches for the toast store, which needs the pinia instance to be the active one.
installErrorSink(app);
// Same reason: an unclaimed 401 is answered by the auth store, which needs pinia installed before it is reached.
setUnauthorizedHandler(() => useAuthStore().noteUnauthorized());
app.mount('#app');
