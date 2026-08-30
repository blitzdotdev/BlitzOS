import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useStableSession } from '@/hooks/useStableSession';
import { useCloudMutation, useCloudQuery, usePlatformCapability } from '@lody/platform/react';
import { useAuthSignOut } from '../../providers/convex-provider';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  WorkspaceJoinRequestPage,
  type WorkspaceJoinPageState,
} from '@/components/pages/workspace-join-request-page';

export const Route = createFileRoute('/join/$token')({
  component: WorkspaceJoinRequestRoute,
});

export function WorkspaceJoinRequestRoute() {
  const { t } = useTranslation();
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const signOut = useAuthSignOut();
  const { data: session, isPending: sessionPending } = useStableSession();
  const joinRequestsAvailable = usePlatformCapability('teamSharing');
  const preview = useCloudQuery(cloudOperations.workspaceJoinRequests.getLinkPreview, { token });
  const submitRequest = useCloudMutation(cloudOperations.workspaceJoinRequests.submitRequest);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const available = preview?.status === 'available' ? preview : null;
  let state: WorkspaceJoinPageState = 'loading';
  if (!joinRequestsAvailable || preview?.status === 'unavailable') state = 'unavailable';
  else if (available && !session?.user) state = 'auth_required';
  else if (available?.viewer?.alreadyMember) state = 'already_member';
  else if (available?.viewer && !available.viewer.emailVerified) state = 'verification_required';
  else if (available?.viewer?.request?.status === 'pending') state = 'pending';
  else if (available?.viewer?.request?.status === 'approved') state = 'approved';
  else if (available?.viewer?.request?.status === 'rejected') state = 'rejected';
  else if (available?.viewer) state = 'form';
  if (sessionPending) state = 'loading';
  if (submitting) state = 'submitting';
  if (errorMessage) state = 'error';

  useEffect(() => {
    if (available?.viewer?.request?.status === 'rejected' && !reason) {
      setReason(available.viewer.request.reason);
    }
  }, [available?.viewer?.request, reason]);

  const goToLogin = () => {
    void navigate({ to: '/login', search: { redirect: `/join/${token}`, view: 'email' } });
  };

  const openWorkspace = () => {
    if (available?.workspaceSlug) {
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: available.workspaceSlug },
      });
      return;
    }
    void navigate({ to: '/' });
  };

  return (
    <WorkspaceJoinRequestPage
      state={state}
      workspaceName={available?.workspaceName}
      currentEmail={session?.user?.email}
      reason={reason}
      errorMessage={errorMessage}
      onReasonChange={setReason}
      onContinue={goToLogin}
      onVerifyEmail={() => {
        void (async () => {
          await signOut();
          goToLogin();
        })();
      }}
      onSubmit={() => {
        void (async () => {
          setSubmitting(true);
          setErrorMessage(null);
          try {
            await submitRequest({ token, reason });
          } catch (error) {
            console.error('Failed to submit workspace join request:', error);
            setErrorMessage(t('joinRequest.submitFailed'));
          } finally {
            setSubmitting(false);
          }
        })();
      }}
      onOpenWorkspace={openWorkspace}
      onBackHome={() => {
        void navigate({ to: '/' });
      }}
    />
  );
}
