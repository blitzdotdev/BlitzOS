export type OrganizationMemberRole = 'admin' | 'member';

export type OrganizationMemberRef = {
  id: string;
  userId: string;
};

export type OrganizationMemberRoleUpdateRequest = {
  organizationId: string;
  memberId: string;
  role: OrganizationMemberRole;
};

export type OrganizationMemberRemovalRequest = {
  organizationId: string;
  memberIdOrEmail: string;
};

export const buildOrganizationMemberRoleUpdateRequest = ({
  organizationId,
  member,
  role,
}: {
  organizationId: string;
  member: OrganizationMemberRef;
  role: OrganizationMemberRole;
}): OrganizationMemberRoleUpdateRequest => ({
  organizationId,
  memberId: member.id,
  role,
});

export const buildOrganizationMemberRemovalRequest = ({
  organizationId,
  member,
}: {
  organizationId: string;
  member: OrganizationMemberRef;
}): OrganizationMemberRemovalRequest => ({
  organizationId,
  memberIdOrEmail: member.id,
});
