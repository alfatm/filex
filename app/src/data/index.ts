import type { Repository } from './repository';
import { HttpRepository } from './http/repository';

/**
 * Single injection point. There is one repository: the app talks to a filex server over HTTP, and nothing else.
 *
 * A mock repository used to sit here, picked whenever `VITE_FILEX_API` was unset — a demo dataset snapshotted
 * from a directory outside this repository. It is gone. The server answers these screens now and the binary
 * serves the app at the apex, so a second source of truth for what a drive holds bought nothing and shipped
 * demo rows into real bundles. `VITE_FILEX_API` still names the server, or `1` when a dev server proxies `/api`.
 */
export const repository: Repository = new HttpRepository();
