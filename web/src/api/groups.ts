import { api } from './client';
import type { UserRole } from './types';

// Tenant-scoped user groups. A group is a principal for RBAC grants (see
// grants.ts): deleting a group removes every grant issued to it.
export interface Group {
  id: number;
  name: string;
  description: string;
  member_count: number;
  created_at: string;
}

export interface GroupMember {
  id: number;
  email: string;
  display_name: string;
  role: UserRole;
}

export interface GroupDetail extends Group {
  members: GroupMember[];
}

export interface GroupListParams {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface GroupListResponse {
  groups: Group[];
  total: number;
  limit: number;
  offset: number;
}

export interface GroupCreateRequest {
  name: string;
  description?: string;
}

export interface GroupUpdateRequest {
  name?: string;
  description?: string;
}

export const GroupsApi = {
  async list(params: GroupListParams = {}): Promise<GroupListResponse> {
    const { data } = await api.get<GroupListResponse>('/admin/groups', { params });
    return { ...data, groups: data.groups ?? [] };
  },

  async get(id: number): Promise<GroupDetail> {
    const { data } = await api.get<GroupDetail>(`/admin/groups/${id}`);
    return { ...data, members: data.members ?? [] };
  },

  async create(payload: GroupCreateRequest): Promise<Group> {
    const { data } = await api.post<Group>('/admin/groups', payload);
    return data;
  },

  async update(id: number, payload: GroupUpdateRequest): Promise<Group> {
    const { data } = await api.patch<Group>(`/admin/groups/${id}`, payload);
    return data;
  },

  async remove(id: number): Promise<void> {
    await api.delete(`/admin/groups/${id}`);
  },

  async setMembers(id: number, userIds: number[]): Promise<void> {
    await api.put(`/admin/groups/${id}/members`, { user_ids: userIds });
  },

  async addMember(id: number, userId: number): Promise<void> {
    await api.post(`/admin/groups/${id}/members`, { user_id: userId });
  },

  async removeMember(id: number, userId: number): Promise<void> {
    await api.delete(`/admin/groups/${id}/members/${userId}`);
  },
};
