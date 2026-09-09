import { createPinia, setActivePinia } from 'pinia';
import { createApp, defineComponent, h } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { useToastStore } from '@/stores/toast';
import { installErrorSink } from './errors';

const Host = defineComponent({ render: () => h('div') });

function sink() {
  const app = createApp(Host);
  app.use(i18n);
  installErrorSink(app);
  return app;
}

describe('the app-wide error sink', () => {
  // The sink listens on the one shared window, so each test takes its listener back off again.
  let added: [string, EventListener][] = [];

  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    added = [];
    const real = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      added.push([type, listener as EventListener]);
      real(type, listener, options);
    });
  });

  afterEach(() => {
    for (const [type, listener] of added) window.removeEventListener(type, listener);
    vi.restoreAllMocks();
  });

  // Without this every rejection outside `operations.run` reached nobody at all: no row, no toast, no message.
  it('says something when a component throws, and keeps the original error on the console', async () => {
    const app = sink();
    const boom = new Error('render blew up');
    app.config.errorHandler!(boom, null, 'test');

    expect(useToastStore().toasts.map((t) => t.text)).toEqual(['Something went wrong']);
    expect(console.error).toHaveBeenCalledWith(boom);
  });

  it('catches a promise nobody awaited', () => {
    sink();
    // happy-dom has no PromiseRejectionEvent; the listener only reads `reason`.
    const event = Object.assign(new Event('unhandledrejection'), { reason: new Error('nobody was listening') });
    window.dispatchEvent(event);

    expect(useToastStore().toasts.map((t) => t.text)).toEqual(['Something went wrong']);
  });
});
