import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

/**
 * Same rewriting for `vite` and `vite preview`: the app is one origin from the browser's side either way, so the
 * session cookie rides along and nothing needs CORS. The target moves with the deployment; a plain local
 * backend is the default.
 */
//
// ⚠ Regexes, not plain prefixes: a plain key matches by string prefix, so '/api' swallowed '/api-keys' — the
// app's own route — and a reload there answered with the BACKEND's index.html, whose asset hashes belong to
// whatever was last built into the binary. The browser then asked this server for an asset it does not have,
// got the SPA fallback HTML back, and refused it as a module: a blank screen on F5. Anchored to a segment
// boundary, '/api-keys' stays with the app and '/api/…' still reaches the server.
const apiProxy = {
  '^/api(?:/|$)': process.env.FILEX_API_PROXY ?? 'http://localhost:5212',
  // The admin console, so the account menu's "Admin settings" opens it from here too. In a deployment the
  // two are one origin already; here they are two ports, and a same-origin link would reopen this app.
  '^/admin(?:/|$)': process.env.FILEX_API_PROXY ?? 'http://localhost:5212',
};

// Vite config for the filex end-user UI. `base` is '/': the app is the product's front door, mounted at the ROOT
// by the Go server (wireStatic in backend/internal/api/routes.go), with the admin console at /admin/ beside it.
// The router reads this same value through `import.meta.env.BASE_URL` rather than repeating it — they are one
// decision, and an index.html whose asset URLs point where nothing answers is what splitting them produces.
//
// This file used to carry three more plugins, all of them in service of a mock repository that no longer exists:
// one served a directory of demo files outside the repository so the mock tree had real bytes, one refused a
// production build that would have shipped the mock, and one aliased the mock out of the bundle when the first
// two were not enough. The app has a single data source now — `src/data/http/` against a filex server — so
// there is nothing to serve, refuse or exclude. `FILEX_API_PROXY` points dev and preview at that server.
//
// See docs/BACKEND-GAP.md § Hosting.
export default defineConfig({
  // Not alone in the terminal: the root `pnpm dev` runs this beside the other Vite server, the package
  // watchers and the Go backend, and Vite's default screen-clearing wipes their output — a backend that
  // failed to bind leaves no trace on screen. Only clears when stdout is a TTY, which is exactly the case
  // a developer is looking at.
  clearScreen: false,
  plugins: [vue()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Maps are emitted for error tooling but not referenced from the bundles.
    sourcemap: 'hidden',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    // Host so the dev server is reachable from outside a container.
    host: process.env.VITE_HOST ?? 'localhost',
    // Behind a container port mapping the browser reaches a different port than Vite binds; the HMR socket has
    // to be told which one to dial, or every edit silently fails to reload.
    hmr: process.env.VITE_HMR_CLIENT_PORT ? { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) } : undefined,
    proxy: apiProxy,
  },
  // `vite preview` serves `dist/`, which is what the live e2e suite runs: a stand pointed at a real server has to
  // show what a BUILD does, not what a dev server does. Same port and host as the dev server so the stand's
  // mapping is the same.
  preview: {
    port: 5174,
    host: process.env.VITE_HOST ?? 'localhost',
    proxy: apiProxy,
  },
});
