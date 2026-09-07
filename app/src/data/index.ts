import type { Repository } from './repository';
import { mockRepository } from './mock';
import { HttpRepository } from './http/repository';

/**
 * Single injection point. The demo data is the default so the app runs with nothing behind it; pointing
 * `VITE_FILEX_API` at a server (or setting it to `1` when the dev server proxies `/api`) switches every screen
 * onto the real one — see docs/BACKEND-GAP.md for what the server does not answer yet.
 */
export const repository: Repository = import.meta.env.VITE_FILEX_API ? new HttpRepository() : mockRepository;
