// Roles and what each one may do with files.
//
//   GET /api/admin/roles         every role with its permissions, plus the catalogue of operations
//   PUT /api/admin/roles/{name}  replace one role's permission list
//
// The admin role is not editable — it always has everything — and the server
// answers 400 to a PUT on it or on an operation it does not know.
import { api } from './client';

export type RoleOpGroup = 'write' | 'organise' | 'share' | 'read';

export interface RoleRow {
  name: string;
  permissions: string[];
  editable: boolean;
}

export interface RoleCatalogueOp {
  /** e.g. `files.upload`; the i18n key `roles.ops.<id>` carries its label and hint. */
  id: string;
  group: RoleOpGroup;
}

export interface RolesResponse {
  roles: RoleRow[];
  catalogue: RoleCatalogueOp[];
}

export const RolesApi = {
  async list(): Promise<RolesResponse> {
    const { data } = await api.get<RolesResponse>('/admin/roles');
    return { roles: data.roles ?? [], catalogue: data.catalogue ?? [] };
  },

  async update(name: string, permissions: string[]): Promise<RoleRow> {
    const { data } = await api.put<RoleRow>(`/admin/roles/${name}`, { permissions });
    return data;
  },
};
