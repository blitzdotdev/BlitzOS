import type { MachineType } from '@blitzos/schema';
import type {
  ComputeCredentialMetadata,
  ComputeCredentialProvider,
  ComputeCredentialsClient,
} from '../compute-credentials-api';
import { InlineComputeCredentialSetup } from '../InlineComputeCredentialSetup';
import { OutlinedLoadingRows } from '../LoadingSkeleton';
import { MachineCatalogGrid } from '../MachineCatalogGrid';

export function TemplateMachineTypePicker({
  loading,
  machines,
  machineTypeId,
  credentialRequiredProviders,
  orgId,
  admin,
  saveCredential,
  onCredentialSaved,
  onSelect,
}: {
  loading: boolean;
  machines: readonly MachineType[];
  machineTypeId: string;
  credentialRequiredProviders: readonly ComputeCredentialProvider[];
  orgId: string;
  admin: boolean;
  saveCredential: ComputeCredentialsClient['putComputeCredential'];
  onCredentialSaved: (metadata: ComputeCredentialMetadata) => Promise<void>;
  onSelect: (machineTypeId: string) => void;
}) {
  return (
    <section className="blueprint-selection">
      <div className="cfg-section-head">
        <h2 className="cfg-title">Machine type</h2>
        <p className="cfg-desc">Workspaces created from this template run on this machine.</p>
      </div>
      {loading ? (
        <OutlinedLoadingRows count={4} ariaLabel="Loading machine types" />
      ) : (
        <>
          <InlineComputeCredentialSetup
            providers={credentialRequiredProviders}
            orgId={orgId}
            admin={admin}
            saveCredential={saveCredential}
            onSaved={onCredentialSaved}
          />
          {machines.length > 0 ? (
            <MachineCatalogGrid
              machines={machines}
              selectedMachineType={machineTypeId}
              onSelect={onSelect}
            />
          ) : credentialRequiredProviders.length === 0 ? (
            <div className="blueprint-selection__empty">No machine types are available.</div>
          ) : null}
        </>
      )}
    </section>
  );
}
