// The operator's quota surface: one default for every account, and the
// per-account overrides laid over it.
//
//   GET   /api/admin/quotas                      the instance defaults
//   PATCH /api/admin/quotas                      change any subset of them
//   GET   /api/admin/quotas/users                every account with its overrides, effective limits and usage
//   PATCH /api/admin/users/{id}/quota            set an account's overrides
//   POST  /api/admin/users/{id}/quota/recompute  rescan an account's usage
//   GET   /api/admin/users/{id}/quota            one account's snapshot + overrides
//
// An override is tri-state: 0 inherits the instance default, -1 makes the
// account unlimited, N > 0 is a limit. An EFFECTIVE value of 0 means unlimited.
// `quota.ts` (the older single-limit surface used by Users → edit) is untouched.
import { api } from './client';
import type { UserRole } from './types';

/** Override value meaning "use the instance default". */
export const OVERRIDE_INHERIT = 0;
/** Override value meaning "no limit for this account". */
export const OVERRIDE_UNLIMITED = -1;

export interface QuotaDefaults {
  quota_bytes: number;
  quota_files: number;
  upload_bytes: number;
  upload_window_hours: number;
}

export type QuotaDefaultsPatch = Partial<QuotaDefaults>;

/** Raw per-account overrides; each is 0 (inherit), -1 (unlimited) or a limit. */
export interface QuotaOverrides {
  quota_bytes: number;
  quota_files: number;
  quota_upload_bytes: number;
}

/** What actually applies to the account; 0 means unlimited. */
export interface QuotaEffective {
  quota_bytes: number;
  quota_files: number;
  upload_bytes: number;
}

export interface QuotaUserRow {
  id: number;
  email: string;
  display_name: string;
  role: UserRole;
  overrides: QuotaOverrides;
  effective: QuotaEffective;
  used_bytes: number;
  used_files: number;
  upload_used_bytes: number;
}

export interface QuotaUsersPage {
  users: QuotaUserRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface QuotaUsersQuery {
  limit?: number;
  offset?: number;
  q?: string;
}

export type UserQuotaPatch = Partial<QuotaOverrides>;

/** `GET /api/admin/users/{id}/quota`: the account's snapshot plus its raw overrides. */
export interface UserQuotaSnapshot {
  used_bytes: number;
  quota_bytes: number;
  percent_used: number;
  unlimited: boolean;
  used_files: number;
  quota_files: number;
  files_unlimited: boolean;
  upload_used_bytes: number;
  upload_quota_bytes: number;
  upload_window_hours: number;
  upload_unlimited: boolean;
  sources: { bytes: string; files: string; upload: string };
  overrides: QuotaOverrides;
}

export const QuotasApi = {
  async getDefaults(): Promise<QuotaDefaults> {
    const { data } = await api.get<{ defaults: QuotaDefaults }>('/admin/quotas');
    return data.defaults;
  },

  async updateDefaults(patch: QuotaDefaultsPatch): Promise<QuotaDefaults> {
    const { data } = await api.patch<{ defaults: QuotaDefaults }>('/admin/quotas', patch);
    return data.defaults;
  },

  async listUsers(query: QuotaUsersQuery = {}): Promise<QuotaUsersPage> {
    const params: Record<string, string | number> = {};
    if (query.limit != null) params.limit = query.limit;
    if (query.offset != null) params.offset = query.offset;
    if (query.q) params.q = query.q;
    const { data } = await api.get<QuotaUsersPage>('/admin/quotas/users', { params });
    return { ...data, users: data.users ?? [] };
  },

  async getUser(id: number): Promise<UserQuotaSnapshot> {
    const { data } = await api.get<UserQuotaSnapshot>(`/admin/users/${id}/quota`);
    return data;
  },

  async updateUser(id: number, patch: UserQuotaPatch): Promise<void> {
    await api.patch(`/admin/users/${id}/quota`, patch);
  },

  async recomputeUser(id: number): Promise<void> {
    await api.post(`/admin/users/${id}/quota/recompute`, {});
  },
};
