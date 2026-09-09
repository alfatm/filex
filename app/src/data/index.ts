import type { Repository } from './repository';
import { mockRepository } from './mock';
import { HttpRepository } from './http/repository';

/**
 * Single injection point. The demo data is the default so the app runs with nothing behind it; pointing
 * `VITE_FILEX_API` at a server (or setting it to `1` when the dev server proxies `/api`) switches every screen
 * onto the real one — see docs/BACKEND-GAP.md for what the server does not answer yet.
 *
 * That default is a dev convenience only: a PRODUCTION build without the variable would look like the product and
 * serve demo data, so `vite build` refuses it (see vite.config.ts) unless the demo is asked for by name,
 * `vite build --mode demo`.
 */
export const repository: Repository = import.meta.env.VITE_FILEX_API ? new HttpRepository() : mockRepository;
