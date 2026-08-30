import { createContext, createElement, useContext, type ReactNode } from 'react';

const ALL_ONBOARDING_STEPS = [
  'ceremony',
  'login',
  'language',
  'theme',
  'appearance',
  'workspace',
  'invite',
  'providers',
  'projects',
  'firstTask',
  'summary',
] as const;

export type OnboardingStepKey = (typeof ALL_ONBOARDING_STEPS)[number];

export function getDesktopOnboardingSteps(input: {
  cloudAccount: boolean;
  multiWorkspace: boolean;
}): readonly OnboardingStepKey[] {
  return [
    'ceremony',
    ...(input.cloudAccount ? (['login'] as const) : []),
    ...(input.multiWorkspace ? (['workspace'] as const) : []),
    'providers',
    'projects',
    'firstTask',
  ];
}

const OnboardingStepsContext = createContext<readonly OnboardingStepKey[]>(ALL_ONBOARDING_STEPS);

export function OnboardingStepsProvider({
  steps,
  children,
}: {
  steps: readonly OnboardingStepKey[];
  children: ReactNode;
}) {
  return createElement(OnboardingStepsContext.Provider, { value: steps }, children);
}

export function useOnboardingStepPosition(step: OnboardingStepKey): {
  current: number;
  total: number;
} {
  const steps = useContext(OnboardingStepsContext);
  const index = steps.indexOf(step);
  return {
    current: index === -1 ? 1 : index + 1,
    total: steps.length,
  };
}
