import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceTemplateView } from '@blitzos/schema';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { NewWorkspaceIcon } from '../WebAppIcons';
import { DriveAvatar } from './DriveAvatar';
import {
  FolderGlyph,
  KebabGlyph,
  PlusGlyph,
  TemplateGlyph,
  TrashGlyph,
} from './DriveIcons';

/** The Templates surface: saved workspace setups as cards. Deliberately no
 * search topbar — the page spans both drive-shell rows. */
export function TemplatesHome({
  client,
  creating,
  onNewTemplate,
  onUseTemplate,
  onOpenRail,
}: {
  client: ControlPlaneClient;
  creating: boolean;
  onNewTemplate: () => void;
  onUseTemplate: (template: WorkspaceTemplateView) => void;
  onOpenRail: () => void;
}) {
  const [templates, setTemplates] = useState<WorkspaceTemplateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceTemplateView | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates((await client.listWorkspaceTemplates()).templates);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load templates.');
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="drive-content drive-content--full">
      <div className="drive-page">
        <div className="tpl-head">
          <button
            className="drive-icon-button drive-topbar-menu"
            type="button"
            aria-label="Open navigation"
            onClick={onOpenRail}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
            </svg>
          </button>
          <h1 className="drive-title">Templates</h1>
          <button className="drive-new-button" type="button" onClick={onNewTemplate}>
            <PlusGlyph /><span>New template</span>
          </button>
        </div>
        <p className="tpl-sub">
          Saved workspace setups — machine size and attached folders. One click starts a workspace from any of them.
        </p>

        {error && <p className="webapp-form-message" role="alert">{error}</p>}

        {templates === null ? (
          <div className="drive-empty" role="status">Loading…</div>
        ) : (
          <div className="tpl-grid">
            {templates.map((template) => (
              <article className="tpl-card" key={template.id}>
                <div className="tpl-card-head">
                  <TemplateGlyph />
                  <span className="tpl-card-name">{template.name}</span>
                  <span className="drive-new-wrap">
                    <button
                      className="tpl-kebab"
                      type="button"
                      aria-label={`Actions for ${template.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === template.id}
                      onClick={() => setMenuFor((open) => open === template.id ? null : template.id)}
                    ><KebabGlyph /></button>
                    {menuFor === template.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Close menu"
                          className="drive-new-scrim"
                          onClick={() => setMenuFor(null)}
                        />
                        <div className="drive-menu drive-new-menu" role="menu">
                          <button
                            className="drive-menu-item drive-menu-item--danger"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              setDeleting(template);
                            }}
                          >
                            <TrashGlyph /><span>Delete template</span>
                          </button>
                        </div>
                      </>
                    )}
                  </span>
                </div>
                <div className="tpl-meta">
                  <span className="tpl-machine">{template.machineTypeId}</span>
                  <span className="tpl-by">
                    <DriveAvatar name={template.createdBy.name} avatarUrl={template.createdBy.avatarUrl} />
                    <span>{template.createdBy.name}</span>
                  </span>
                </div>
                {template.folders.length === 0 ? (
                  <span className="tpl-folders-empty">No folders attached</span>
                ) : (
                  <div className="tpl-folders">
                    {template.folders.map((folder) => (
                      <span
                        className={`tpl-folder${folder.role === null ? ' tpl-folder--locked' : ''}`}
                        key={folder.id}
                        title={folder.role === null ? 'Shared with you when you use this template' : undefined}
                      >
                        <FolderGlyph />
                        <span>{folder.role === null ? `${folder.name} — no access yet` : folder.name}</span>
                      </span>
                    ))}
                  </div>
                )}
                <div className="tpl-foot">
                  <button
                    className="tpl-use"
                    type="button"
                    disabled={creating}
                    onClick={() => onUseTemplate(template)}
                  >
                    <NewWorkspaceIcon /><span>New workspace</span>
                  </button>
                </div>
              </article>
            ))}
            <button className="tpl-ghost" type="button" onClick={onNewTemplate}>
              <span><PlusGlyph />New template</span>
            </button>
          </div>
        )}
      </div>

      {deleting !== null && (
        <ConfirmationDialog
          title="Delete template?"
          description={`Are you sure you want to delete “${deleting.name}”? Workspaces already created from it keep running.`}
          confirmLabel="Yes, delete"
          cancelLabel="No"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            void client.deleteWorkspaceTemplate(target.id)
              .then(load)
              .catch((caught: Error) => setError(caught.message));
          }}
        />
      )}
    </div>
  );
}
