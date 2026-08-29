import { useEffect, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useRouter } from '@tanstack/react-router';
import { currentWorkspaceSlugAtom } from '@/atoms';
import {
  readTasksFeatureEnabledFromStorage,
  tasksFeatureEnabledAtom,
} from '@/atoms/settings';

/**
 * A typed URL is the one Tasks entry point the beta gate cannot take away — the
 * routes exist in the router whether or not the feature is on, and a bookmark,
 * a deep link, or a back-navigation from before the flag was turned off can all
 * land here. So the routes check the gate themselves: with the beta off nothing
 * renders and the app returns to chat, which is what a user who never enabled
 * Tasks would experience from a URL that was never a page.
 *
 * The redirect lives here rather than in `beforeLoad` because the gate is a
 * browser-local jotai atom; reading it from router context would duplicate the
 * storage key and lose the reactivity that hides the page the moment Developer
 * mode goes off while it is open.
 *
 * Deep-link hazard: `atomWithStorage` can report `false` on the first paint
 * before its onMount rehydrates from localStorage. Redirecting in that frame
 * turns a bookmarked `/tasks/$taskId` into chat. We therefore (1) also trust a
 * synchronous storage read for the first paint, and (2) only fire the redirect
 * after the mount pass so onMount has applied.
 */
export function TasksBetaRouteGuard({ children }: { children: ReactNode }) {
  const enabledFromAtom = useAtomValue(tasksFeatureEnabledAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const router = useRouter();
  const [storageSettled, setStorageSettled] = useState(false);

  useEffect(() => {
    setStorageSettled(true);
  }, []);

  // While the atom may still be on its default, storage is the source of truth
  // for "did this user enable Tasks on this device?". After settle, the atom
  // alone drives the gate so turning Developer mode off still unmounts live.
  const enabled =
    enabledFromAtom || (!storageSettled && readTasksFeatureEnabledFromStorage());

  useEffect(() => {
    if (!storageSettled || enabledFromAtom || !workspaceSlug) return;
    void router.navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName: workspaceSlug },
      replace: true,
    });
  }, [enabledFromAtom, router, storageSettled, workspaceSlug]);

  if (!enabled) return null;
  return <>{children}</>;
}
