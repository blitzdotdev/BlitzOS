import type { MeResponse } from './api.js';

export type Agent = 'claude' | 'codex';
export type TerminalAgent = Agent | 'opencode' | 'pi' | 'kimi' | 'prime';

export type IdentityRecord = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  platformOperator?: boolean;
};

export type MembershipRecord = {
  id: string;
  role: 'admin' | 'member';
};

export type OrgRecord = {
  id: string;
  slug: string;
  name: string;
  vmLimit: number;
};

export type TenantMe = {
  identity: IdentityRecord;
  membership: MembershipRecord;
  org: OrgRecord;
  organizations: Array<{ membership: MembershipRecord; org: OrgRecord }>;
};

export type Me = {
  identity: IdentityRecord;
  membership: MembershipRecord | null;
  org: OrgRecord | null;
  organizations: Array<{ membership: MembershipRecord; org: OrgRecord }>;
};

export function isTenantMe(viewer: Me): viewer is TenantMe {
  return viewer.membership !== null && viewer.org !== null;
}

export function meFromWire(me: MeResponse): Me {
  return {
    identity: {
      id: me.user.id,
      email: me.user.email,
      name: me.user.name,
      avatarUrl: me.user.avatarUrl,
      platformOperator: me.user.platformOperator,
    },
    membership: me.membership === null
      ? null
      : { id: me.membership.id, role: me.membership.role },
    org: me.org === null
      ? null
      : { id: me.org.id, slug: me.org.slug, name: me.org.name, vmLimit: me.org.vmLimit },
    organizations: me.organizations.map((item) => ({
      membership: { id: item.membership.id, role: item.membership.role },
      org: {
        id: item.org.id,
        slug: item.org.slug,
        name: item.org.name,
        vmLimit: item.org.vmLimit,
      },
    })),
  };
}
