import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { ApiAdapter, type TenantMe } from './api-adapter';
import type { ControlPlaneClient } from './api';
import { caughtErrorMessage } from './error-message';
import type { IdentityRecord } from './protocol';

type StateSetter<Value> = Dispatch<SetStateAction<Value>>;

type OrganizationTransitionOptions = {
  api: ApiAdapter;
  client: ControlPlaneClient;
  viewer: TenantMe | null;
  setIdentityOnly: StateSetter<IdentityRecord | null>;
  setLoaded: StateSetter<boolean>;
  setBootstrapVersion: StateSetter<number>;
  setShowCreateOrg: StateSetter<boolean>;
  setError: StateSetter<string | null>;
};

/** Hides the previous organization behind one loading shell while a session-
 * rebinding request settles, then reveals that untouched view on rejection. */
export function useOrganizationOptimisticTransitions({
  api,
  client,
  viewer,
  setIdentityOnly,
  setLoaded,
  setBootstrapVersion,
  setShowCreateOrg,
  setError,
}: OrganizationTransitionOptions) {
  const [transitionStage, setTransitionStage] = useState<string | null>(null);
  // The form unmounts under the loading shell, so its draft must live above it.
  const [createOrgName, setCreateOrgName] = useState('');

  const openCreateOrganization = useCallback(() => {
    setCreateOrgName('');
    setError(null);
    setShowCreateOrg(true);
  }, [setError, setShowCreateOrg]);

  const closeCreateOrganization = useCallback(() => {
    setShowCreateOrg(false);
    setCreateOrgName('');
  }, [setShowCreateOrg]);

  const createOrganization = useCallback(async (
    name: string,
    origin: 'identity' | 'dialog',
  ) => {
    setError(null);
    if (origin === 'dialog') setShowCreateOrg(false);
    setTransitionStage(`creating · ${name}`);
    try {
      await api.createOrg(name);
    } catch (cause) {
      setTransitionStage(null);
      if (origin === 'dialog') setShowCreateOrg(true);
      setError(`Could not create “${name}”: ${caughtErrorMessage(
        cause,
        'The control plane request failed.',
      )}`);
      return;
    }
    if (origin === 'dialog') {
      // Create rebinds the session to the new organization.
      window.location.reload();
      return;
    }
    setIdentityOnly(null);
    setLoaded(false);
    setTransitionStage(null);
    setBootstrapVersion((version) => version + 1);
  }, [
    api,
    setBootstrapVersion,
    setError,
    setIdentityOnly,
    setLoaded,
    setShowCreateOrg,
  ]);

  const createOrganizationFromIdentity = useCallback(
    (name: string) => createOrganization(name, 'identity'),
    [createOrganization],
  );
  const createOrganizationFromDialog = useCallback(
    (name: string) => createOrganization(name, 'dialog'),
    [createOrganization],
  );

  const switchOrganization = useCallback((orgId: string) => {
    const target = viewer?.organizations.find(({ org }) => org.id === orgId)?.org;
    const label = target?.name || target?.slug || 'organization';
    setError(null);
    setTransitionStage(`switching · ${label}`);
    void client.switchOrg(orgId)
      .then(() => window.location.reload())
      .catch((cause: unknown) => {
        setTransitionStage(null);
        setError(`Could not switch to “${label}”: ${caughtErrorMessage(
          cause,
          'The control plane request failed.',
        )}`);
      });
  }, [client, setError, viewer]);

  const leaveOrganization = useCallback(() => {
    const label = viewer?.org.name || viewer?.org.slug || 'organization';
    setError(null);
    setTransitionStage(`leaving · ${label}`);
    void client.leaveOrg()
      .then(() => window.location.reload())
      .catch((cause: unknown) => {
        setTransitionStage(null);
        setError(`Could not leave “${label}”: ${caughtErrorMessage(
          cause,
          'The control plane request failed.',
        )}`);
      });
  }, [client, setError, viewer]);

  return {
    transitionStage,
    createOrgName,
    setCreateOrgName,
    openCreateOrganization,
    closeCreateOrganization,
    createOrganizationFromIdentity,
    createOrganizationFromDialog,
    switchOrganization,
    leaveOrganization,
  };
}
