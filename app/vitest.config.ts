import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      /**
       * The DESIGN width, not happy-dom's own 1024.
       *
       * A unit test that says nothing about the window should get the window the spec is measured at, so what it
       * asserts about geometry is what the reference draws; a test about the phone layout stubs `matchMedia` and
       * says so (see src/test/viewport.ts).
       */
      environmentOptions: { happyDOM: { width: 1672, height: 941 } },
      include: ['src/**/*.test.ts'],
    },
  }),
);
