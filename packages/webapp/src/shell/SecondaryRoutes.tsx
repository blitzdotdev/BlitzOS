import type { ReactNode } from 'react';
import type { ControlPlaneClient } from '../api';
import type { TenantMe } from '../api-adapter';
import type { CreateWorkspaceDialogInput } from '../CreateWorkspaceDialog';
import { CreateRecipeScreen } from '../files/CreateRecipeScreen';
import { CreateTemplateScreen } from '../files/CreateTemplateScreen';
import { DriveHome } from '../files/DriveHome';
import type { DriveRailNav } from '../files/DriveRail';
import { RecipesHome } from '../files/RecipesHome';
import { TemplatesHome } from '../files/TemplatesHome';
import { SettingsHeader, SettingsPage } from '../SettingsPage';
import {
  recipeEditPath,
  recipeNewPath,
  recipesPath,
  templateEditPath,
  templateNewPath,
  templatesPath,
  type AppRoute,
  type SettingsSection,
} from '../sessions-page-state';

/** Pages the shell draws beside the rail instead of a workspace. Settings is
 * one of them even though it hides the rail: it is still not the webApp. */
export type SecondaryRoutePage =
  | 'drive'
  | 'folder'
  | 'templates'
  | 'template-new'
  | 'template-edit'
  | 'recipes'
  | 'recipe-new'
  | 'recipe-edit'
  | 'settings';

const SECONDARY_ROUTE_PAGES = new Set<string>([
  'drive',
  'folder',
  'templates',
  'template-new',
  'template-edit',
  'recipes',
  'recipe-new',
  'recipe-edit',
  'settings',
]);

export function isSecondaryRoute(
  route: AppRoute,
): route is Extract<AppRoute, { page: SecondaryRoutePage }> {
  return SECONDARY_ROUTE_PAGES.has(route.page);
}

export type SecondaryRoutesProps = {
  route: Extract<AppRoute, { page: SecondaryRoutePage }>;
  client: ControlPlaneClient;
  viewer: TenantMe | null;
  loaded: boolean;
  /** The shared rail, parameterized by which nav row is current. */
  rail: (nav: DriveRailNav | null) => ReactNode;
  dialogs: ReactNode;
  updateNotice: ReactNode;
  error: string | null;
  onDismissError: () => void;
  createWorkspaceBusy: boolean;
  createWorkspaceError: string | null;
  onDismissCreateWorkspaceError: () => void;
  onCreateWorkspace: (input: CreateWorkspaceDialogInput) => void;
  onLaunchRecipe: (recipeId: string) => void;
  onNavigate: (path: string) => void;
  onOpenRail: () => void;
  onNavigateToSettings: (section: SettingsSection) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onLeaveSettings: () => void;
  onSignOut: () => Promise<void>;
  onLeftOrg: () => void;
  activeWorkspaceTitle: string | undefined;
};

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="webapp-notice" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

function Loading() {
  return (
    <div className="drive-content">
      <div className="drive-empty" role="status">Loading…</div>
    </div>
  );
}

/** The route switch for every page that is not a workspace. Each branch is the
 * same shell: rail, content, notices, dialogs. */
export function SecondaryRoutes({
  route,
  client,
  viewer,
  loaded,
  rail,
  dialogs,
  updateNotice,
  error,
  onDismissError,
  createWorkspaceBusy,
  createWorkspaceError,
  onDismissCreateWorkspaceError,
  onCreateWorkspace,
  onLaunchRecipe,
  onNavigate,
  onOpenRail,
  onNavigateToSettings,
  onOpenWorkspace,
  onLeaveSettings,
  onSignOut,
  onLeftOrg,
  activeWorkspaceTitle,
}: SecondaryRoutesProps) {
  const notice = error === null
    ? null
    : <Notice message={error} onDismiss={onDismissError} />;
  const createNotice = createWorkspaceError === null
    ? null
    : <Notice message={createWorkspaceError} onDismiss={onDismissCreateWorkspaceError} />;

  if (route.page === 'settings') {
    return (
      <main className="settings-shell" aria-busy={!loaded}>
        <SettingsHeader workspaceLabel={activeWorkspaceTitle} onBack={onLeaveSettings} />
        {loaded && viewer ? (
          <SettingsPage
            client={client}
            viewer={viewer}
            section={route.settingsSection}
            onNavigate={onNavigateToSettings}
            onOpenWorkspace={onOpenWorkspace}
            onSignOut={onSignOut}
            onLeftOrg={onLeftOrg}
          />
        ) : (
          <div className="settings-page-state settings-page-state--loading" role="status">
            Loading settings…
          </div>
        )}
        {notice}
        {updateNotice}
      </main>
    );
  }

  if (route.page === 'drive' || route.page === 'folder') {
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {rail('drive')}
        {loaded && viewer ? (
          <DriveHome
            client={client}
            viewer={viewer}
            route={route}
            onNavigate={onNavigate}
            onOpenRail={onOpenRail}
          />
        ) : <Loading />}
        {notice}
        {updateNotice}
        {dialogs}
      </main>
    );
  }

  if (route.page === 'templates') {
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {rail('templates')}
        {loaded && viewer ? (
          <TemplatesHome
            client={client}
            creating={createWorkspaceBusy}
            onNewTemplate={() => onNavigate(templateNewPath())}
            onEditTemplate={(template) => onNavigate(templateEditPath(template.id))}
            onUseTemplate={(template) => {
              onCreateWorkspace({ templateId: template.id, orgShareRole: 'editor' });
            }}
            onOpenRail={onOpenRail}
          />
        ) : <Loading />}
        {createNotice}
        {notice}
        {updateNotice}
        {dialogs}
      </main>
    );
  }

  if (route.page === 'recipes') {
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {rail('recipes')}
        {loaded && viewer ? (
          <RecipesHome
            client={client}
            launching={createWorkspaceBusy}
            onNewRecipe={() => onNavigate(recipeNewPath())}
            onEditRecipe={(recipe) => onNavigate(recipeEditPath(recipe.id))}
            onRunRecipe={(recipe) => onLaunchRecipe(recipe.id)}
            onOpenRail={onOpenRail}
          />
        ) : <Loading />}
        {createNotice}
        {notice}
        {updateNotice}
        {dialogs}
      </main>
    );
  }

  if (route.page === 'recipe-new' || route.page === 'recipe-edit') {
    const leaveToRecipes = () => onNavigate(recipesPath());
    return (
      <main className="drive-shell" aria-busy={!loaded}>
        {rail('recipes')}
        {loaded && viewer ? (
          <CreateRecipeScreen
            client={client}
            editRecipeId={route.page === 'recipe-edit' ? route.recipeId : undefined}
            onSaved={leaveToRecipes}
            onCancel={leaveToRecipes}
          />
        ) : <Loading />}
        {notice}
        {dialogs}
      </main>
    );
  }

  const leaveToTemplates = () => onNavigate(templatesPath());
  return (
    <main className="drive-shell" aria-busy={!loaded}>
      {rail('templates')}
      {loaded && viewer ? (
        <CreateTemplateScreen
          client={client}
          orgId={viewer.org.id}
          orgName={viewer.org.name}
          admin={viewer.membership.role === 'admin'}
          editTemplateId={route.page === 'template-edit' ? route.templateId : undefined}
          isAdmin={viewer.membership.role === 'admin'}
          onCreated={leaveToTemplates}
          onCancel={leaveToTemplates}
        />
      ) : <Loading />}
      {notice}
      {dialogs}
    </main>
  );
}
