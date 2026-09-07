import type { Repository } from './repository';
import { mockRepository } from './mock';

// Single injection point: swap for the HTTP implementation once the API lands.
export const repository: Repository = mockRepository;
