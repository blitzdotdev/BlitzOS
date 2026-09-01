import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider, useAtomValue } from 'jotai';
import { ExperimentalFeaturesSection } from '@/components/settings/experimental-features-setting';
import {
  experimentalFeaturesEnabledAtom,
  reviewAgentExperimentEnabledAtom,
  reviewAgentFeatureEnabledAtom,
} from '@/atoms/settings';
import { settingContainerClass } from '@/components/settings';

/**
 * Two switches, one derived gate. Unlike the Developer-mode beta section the
 * master switch is always visible, so the "off" state is a real state a user
 * sees rather than an empty region.
 */
function GateReadout() {
  const enabled = useAtomValue(reviewAgentFeatureEnabledAtom);
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      <span className="font-mono">reviewAgentFeatureEnabledAtom</span> ={' '}
      <span className="font-mono font-semibold">{String(enabled)}</span>
      {enabled
        ? ' — the session menu offers Auto review and merge.'
        : ' — no session can be handed to the review agent.'}
    </p>
  );
}

function Harness({
  experimental,
  reviewAgent,
}: {
  experimental: boolean;
  reviewAgent: boolean;
}) {
  // Seeded once per story: rebuilding the store on every render would discard
  // the switch the viewer just clicked.
  const [store] = useState(() => {
    const created = createStore();
    created.set(experimentalFeaturesEnabledAtom, experimental);
    created.set(reviewAgentExperimentEnabledAtom, reviewAgent);
    return created;
  });

  return (
    <Provider store={store}>
      <div className={settingContainerClass}>
        <ExperimentalFeaturesSection />
        <GateReadout />
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Settings/ExperimentalFeaturesSetting',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default for everyone: the master switch, and nothing else. */
export const Collapsed: Story = {
  args: { experimental: false, reviewAgent: false },
};

/** Master switch on, feature not yet opted into. */
export const Expanded: Story = {
  args: { experimental: true, reviewAgent: false },
};

/** Both on — the state in which the session menu grows its checkbox. */
export const ReviewAgentEnabled: Story = {
  args: { experimental: true, reviewAgent: true },
};

/**
 * Master off while the per-feature opt-in is remembered. Turning the master
 * switch back on must restore this choice rather than reset it.
 */
export const OptInRemembered: Story = {
  args: { experimental: false, reviewAgent: true },
};
