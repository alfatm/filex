import { api } from './client';

export type GrantLevel = 'viewer' | 'editor' | 'owner';

// Who a grant is issued to. Rows older than the groups feature carry no
// `principal` at all — treat absent as 'user'.
export type GrantPrincipal = 'user' | 'group';

export interface AdminGrant {
  id: number;
  storage_id: number;
  storage_name: string;
  path: string;
  path_prefix: string;
  is_dir: boolean;
  principal?: GrantPrincipal;
  // User rows only.
  user_id?: number;
  user_email?: string;
  user_display_name?: string;
  // Group rows only.
  group_id?: number;
  group_name?: string;
  level: GrantLevel;
  created_at: string;
}

export interface GrantCreateRequest {
  storage_id: number;
  /** Relative to the storage root; "" = the root itself. */
  path: string;
  is_dir: boolean;
  level: GrantLevel;
  user_id?: number;
  group_id?: number;
}

export const AdminGrantsApi = {
  async list(): Promise<AdminGrant[]> {
    const { data } = await api.get<{ grants: AdminGrant[] }>('/admin/grants');
    return data.grants ?? [];
  },
  async create(payload: GrantCreateRequest): Promise<AdminGrant> {
    const { data } = await api.post<AdminGrant>('/admin/grants', payload);
    return data;
  },
  async update(id: number, level: GrantLevel, principal: GrantPrincipal = 'user'): Promise<void> {
    await api.patch(`/admin/grants/${id}`, { level }, { params: { principal } });
  },
  async remove(id: number, principal: GrantPrincipal = 'user'): Promise<void> {
    // `?principal` is only meaningful for group rows; the server treats absent as user.
    await api.delete(`/admin/grants/${id}`, {
      params: principal === 'group' ? { principal } : {},
    });
  },
};
