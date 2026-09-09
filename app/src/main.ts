import { createApp } from 'vue';
import { createPinia } from 'pinia';

import App from './App.vue';
import { installErrorSink } from './lib/errors';
import router from './router';
import { i18n } from './i18n';

import './design/main.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(i18n);
// After the plugins: the sink reaches for the toast store, which needs the pinia instance to be the active one.
installErrorSink(app);
app.mount('#app');
