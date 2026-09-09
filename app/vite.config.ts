import { defineConfig, loadEnv, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The mock dataset (src/data/mock/tree.json, see scripts/gen-demo-tree.mjs) mirrors a directory of real demo
 * files. This plugin serves that directory under `<base>demo-assets/` in dev and copies it whole into
 * `dist/demo-assets/` on build, so thumbnails, the preview modal and downloads work on the real files.
 * `?download=1` on any URL adds `Content-Disposition: attachment`. Without the directory the app still runs on
 * placeholders.
 */
const DEMO_ASSETS_DIR = path.resolve(__dirname, process.env.DEMO_ASSETS_DIR ?? '../../drive-demo-assets/demo');
const DEMO_ASSETS_ROUTE = 'demo-assets/';
const TEXT = 'text/plain; charset=utf-8';
// Code and config files are served as plain text so "Open in new tab" renders them instead of downloading.
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  psd: 'image/vnd.adobe.photoshop',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  txt: TEXT,
  log: TEXT,
  ts: TEXT,
  py: TEXT,
  go: TEXT,
  sh: TEXT,
  sql: TEXT,
  toml: TEXT,
  env: TEXT,
  yaml: TEXT,
  yml: TEXT,
  dockerfile: TEXT,
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  ics: 'text/calendar; charset=utf-8',
  vcf: 'text/vcard; charset=utf-8',
  rtf: 'application/rtf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  zip: 'application/zip',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  jar: 'application/java-archive',
  iso: 'application/x-iso9660-image',
  sqlite: 'application/vnd.sqlite3',
};

/** Extension in lower case; extension-less names (Dockerfile) use the whole name so they can map to a type too. */
const extensionOf = (file: string) => (path.extname(file) || path.basename(file)).replace(/^\./, '').toLowerCase();

/** Every file below `dir` (dotfiles skipped), as paths relative to it. */
function walk(dir: string, relative = ''): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .flatMap((name) => {
      const entry = relative ? `${relative}/${name}` : name;
      return statSync(path.join(dir, name)).isDirectory() ? walk(path.join(dir, name), entry) : [entry];
    });
}

function demoAssets(): Plugin {
  let base = '/';
  let outDir = 'dist';
  let building = false;
  return {
    name: 'filex-demo-assets',
    configResolved(config) {
      base = config.base;
      outDir = config.build.outDir;
      building = config.command === 'build';
      if (!existsSync(DEMO_ASSETS_DIR)) {
        config.logger.warn(`demo assets not found at ${DEMO_ASSETS_DIR}; thumbnails use placeholders (set DEMO_ASSETS_DIR)`);
      }
    },
    configureServer(server) {
      const prefix = `${base}${DEMO_ASSETS_ROUTE}`;
      server.middlewares.use((req, res, next) => {
        const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
        if (!pathname.startsWith(prefix)) return next();
        const file = path.resolve(DEMO_ASSETS_DIR, decodeURIComponent(pathname.slice(prefix.length)));
        // `resolve` normalises `..`; anything outside the directory (or missing) is a 404.
        if (!file.startsWith(`${DEMO_ASSETS_DIR}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const size = statSync(file).size;
        res.setHeader('Content-Type', CONTENT_TYPES[extensionOf(file)] ?? 'application/octet-stream');
        if (searchParams.get('download') === '1') {
          res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
        }
        res.setHeader('Accept-Ranges', 'bytes');
        // <video> seeks with range requests.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (range && size > 0) {
          const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', end - start + 1);
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.setHeader('Content-Length', size);
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!building || !existsSync(DEMO_ASSETS_DIR)) return;
      const target = path.resolve(__dirname, outDir, 'demo-assets');
      const shipped = walk(DEMO_ASSETS_DIR);
      for (const file of shipped) {
        mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
        copyFileSync(path.join(DEMO_ASSETS_DIR, file), path.join(target, file));
      }
      this.info(`copied ${shipped.length} demo assets to ${path.relative(__dirname, target)}/`);
    },
  };
}

/**
 * `src/data/index.ts` picks the mock repository whenever `VITE_FILEX_API` is unset. In dev that is the point —
 * the app runs with nothing behind it. In a production build it is a trap: the bundle looks like the product and
 * serves demo data, and nothing on screen says so. So that build refuses to start. A demo bundle is still
 * buildable, but has to say it is one: `vite build --mode demo`.
 */
function requireApiTarget(): Plugin {
  return {
    name: 'filex-require-api-target',
    config(_config, { command, mode }) {
      if (command !== 'build' || mode !== 'production') return;
      // Reads `.env*` next to this file as well as the process environment, which is where the stand sets it.
      if (loadEnv(mode, __dirname, 'VITE_').VITE_FILEX_API) return;
      throw new Error(
        'VITE_FILEX_API is not set: this production build would ship the mock repository and look like the real app.\n' +
          '  Set VITE_FILEX_API=1 (dev server proxies /api) or to the server URL, or build the demo explicitly:\n' +
          '  vite build --mode demo',
      );
    },
  };
}

/**
 * Same rewriting for `vite` and `vite preview`: the app is one origin from the browser's side either way, so the
 * session cookie rides along and nothing needs CORS. The target moves with the deployment — docker-compose.app.yml
 * points it at the `filex` service; a plain local backend is the default.
 */
const apiProxy = {
  '/api': process.env.FILEX_API_PROXY ?? 'http://localhost:5212',
  // The admin console, so the account menu's "Admin settings" opens it from here too. In a deployment the
  // two are one origin already; here they are two ports, and a same-origin link would reopen this app.
  '/admin': process.env.FILEX_API_PROXY ?? 'http://localhost:5212',
};

// Vite config for the filex end-user UI. `base` MUST stay '/app/': it is the path the app is served from and the
// prefix its router and asset URLs are built with. Nothing in the Go server mounts it — `backend/embed` carries
// the admin SPA and the embed widget only, and there is no `/app` route — so the one way to run this today is
// `docker-compose.app.yml`, which serves the built bundle under that same base. See docs/BACKEND-GAP.md § Hosting.
export default defineConfig({
  plugins: [vue(), demoAssets(), requireApiTarget()],
  base: '/app/',
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
  // `vite preview` serves `dist/`, which is what docker-compose.app.yml runs: a stand pointed at a real server
  // has to show what a BUILD does, and the dev server's screenshot/e2e hooks (src/dev/screenshotQuery.ts, behind
  // `import.meta.env.DEV`) are not in one. Same port and host as the dev server so the stand's mapping is the same.
  preview: {
    port: 5174,
    host: process.env.VITE_HOST ?? 'localhost',
    proxy: apiProxy,
  },
});
