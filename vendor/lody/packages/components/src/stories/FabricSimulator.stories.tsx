import type { Meta, StoryObj } from '@storybook/react';

import {
  FABRIC_PRESETS,
  type FabricPresetName,
  type FabricRecipe,
  type WeavePatternName,
} from '@/components/fabric/fabric-recipe';
import { FabricSimulator } from '@/components/fabric/fabric-simulator';

/** Flat args so every recipe field is tweakable from Storybook controls. */
interface PlaygroundArgs {
  mode: 'plane' | 'cylinder';
  followPointer: boolean;
  // fiber
  alignment: number;
  melange: number;
  melangeColorA: string;
  melangeColorB: string;
  // yarn
  twist: number;
  twistDirection: 'S' | 'Z';
  radiusWarp: number;
  radiusWeft: number;
  slub: number;
  hairiness: number;
  yarnVariation: number;
  // weave
  pattern: WeavePatternName;
  threadPx: number;
  crimp: number;
  flatten: number;
  warpColors: string;
  weftColors: string;
  // finish
  milling: number;
  raising: number;
  pressing: number;
  // light
  lightX: number;
  lightY: number;
  lightZ: number;
  lightIntensity: number;
  lightSize: number;
  ambient: number;
  seed: number;
}

function parseColors(csv: string, fallback: string[]): string[] {
  const list = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s.replace('#', '')));
  return list.length > 0 ? list.map((s) => (s.startsWith('#') ? s : `#${s}`)) : fallback;
}

function recipeFromArgs(a: PlaygroundArgs): FabricRecipe {
  return {
    fiber: {
      alignment: a.alignment,
      melangeColors: [a.melangeColorA, a.melangeColorB],
      melange: a.melange,
    },
    yarn: {
      twist: a.twist,
      twistDirection: a.twistDirection,
      radiusWarp: a.radiusWarp,
      radiusWeft: a.radiusWeft,
      slub: a.slub,
      hairiness: a.hairiness,
      yarnVariation: a.yarnVariation,
    },
    weave: {
      pattern: a.pattern,
      threadPx: a.threadPx,
      crimp: a.crimp,
      flatten: a.flatten,
      warpColors: parseColors(a.warpColors, ['#2e323f']),
      weftColors: parseColors(a.weftColors, ['#292d38']),
    },
    finish: { milling: a.milling, raising: a.raising, pressing: a.pressing },
  };
}

type RecipeArgs = Omit<
  PlaygroundArgs,
  | 'mode'
  | 'followPointer'
  | 'lightX'
  | 'lightY'
  | 'lightZ'
  | 'lightIntensity'
  | 'lightSize'
  | 'ambient'
  | 'seed'
>;

function argsFromPreset(name: FabricPresetName): RecipeArgs {
  const p = FABRIC_PRESETS[name];
  return {
    alignment: p.fiber.alignment,
    melange: p.fiber.melange,
    melangeColorA: p.fiber.melangeColors[0],
    melangeColorB: p.fiber.melangeColors[1],
    twist: p.yarn.twist,
    twistDirection: p.yarn.twistDirection,
    radiusWarp: p.yarn.radiusWarp,
    radiusWeft: p.yarn.radiusWeft,
    slub: p.yarn.slub,
    hairiness: p.yarn.hairiness,
    yarnVariation: p.yarn.yarnVariation,
    pattern: p.weave.pattern,
    threadPx: p.weave.threadPx,
    crimp: p.weave.crimp,
    flatten: p.weave.flatten,
    warpColors: p.weave.warpColors.join(','),
    weftColors: p.weave.weftColors.join(','),
    milling: p.finish.milling,
    raising: p.finish.raising,
    pressing: p.finish.pressing,
  };
}

function Playground(args: PlaygroundArgs) {
  const recipe = recipeFromArgs(args);
  return (
    <div style={{ height: '100dvh' }}>
      <FabricSimulator
        recipe={recipe}
        mode={args.mode}
        followPointer={args.followPointer}
        seed={args.seed}
        light={{
          x: args.lightX,
          y: args.lightY,
          z: args.lightZ,
          intensity: args.lightIntensity,
          size: args.lightSize,
          ambient: args.ambient,
        }}
      />
    </div>
  );
}

const range = (min: number, max: number, step = 0.01) => ({
  control: { type: 'range' as const, min, max, step },
});
const cat = (category: string) => ({ table: { category } });

const meta = {
  title: 'Effects/FabricSimulator',
  component: Playground,
  parameters: { layout: 'fullscreen' },
  argTypes: {
    mode: { options: ['plane', 'cylinder'], control: { type: 'radio' } },
    followPointer: { control: 'boolean' },
    alignment: { ...range(0, 1), ...cat('fiber') },
    melange: { ...range(0, 1), ...cat('fiber') },
    melangeColorA: { control: 'color', ...cat('fiber') },
    melangeColorB: { control: 'color', ...cat('fiber') },
    twist: { ...range(0, 1), ...cat('yarn') },
    twistDirection: { options: ['S', 'Z'], control: { type: 'radio' }, ...cat('yarn') },
    radiusWarp: { ...range(0.2, 0.5), ...cat('yarn') },
    radiusWeft: { ...range(0.2, 0.5), ...cat('yarn') },
    slub: { ...range(0, 1), ...cat('yarn') },
    hairiness: { ...range(0, 1), ...cat('yarn') },
    yarnVariation: { ...range(0, 1), ...cat('yarn') },
    pattern: {
      options: [
        'plain',
        'twill-2-2',
        'twill-3-1',
        'satin-5',
        'hopsack-2-2',
        'herringbone',
        'birdseye',
      ],
      control: { type: 'select' },
      ...cat('weave'),
    },
    threadPx: { ...range(2, 24, 1), ...cat('weave') },
    crimp: { ...range(0, 1), ...cat('weave') },
    flatten: { ...range(0, 1), ...cat('weave') },
    warpColors: { control: 'text', ...cat('weave') },
    weftColors: { control: 'text', ...cat('weave') },
    milling: { ...range(0, 1), ...cat('finish') },
    raising: { ...range(0, 1), ...cat('finish') },
    pressing: { ...range(0, 1), ...cat('finish') },
    lightX: { ...range(-1.5, 1.5), ...cat('light') },
    lightY: { ...range(-1.5, 1.5), ...cat('light') },
    lightZ: { ...range(0.2, 2), ...cat('light') },
    lightIntensity: { ...range(0, 4), ...cat('light') },
    lightSize: { ...range(0, 1), ...cat('light') },
    ambient: { ...range(0, 1.5), ...cat('light') },
    seed: { control: { type: 'number' } },
  },
} satisfies Meta<PlaygroundArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseArgs: PlaygroundArgs = {
  ...argsFromPreset('worstedTwill'),
  mode: 'plane',
  followPointer: true,
  lightX: 0.25,
  lightY: 0.3,
  lightZ: 0.9,
  lightIntensity: 1.6,
  lightSize: 0.3,
  ambient: 0.5,
  seed: 0,
};

export const PlaygroundStory: Story = {
  name: 'Playground',
  args: baseArgs,
};

export const WorstedTwill: Story = { args: { ...baseArgs, ...argsFromPreset('worstedTwill') } };
export const Hopsack: Story = { args: { ...baseArgs, ...argsFromPreset('hopsack') } };
export const Flannel: Story = { args: { ...baseArgs, ...argsFromPreset('flannel') } };
export const Tweed: Story = { args: { ...baseArgs, ...argsFromPreset('tweed') } };

export const Presets: Story = {
  args: baseArgs,
  render: () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
        gap: 16,
        padding: 16,
        minHeight: '100dvh',
        alignContent: 'start',
        background: '#101012',
      }}
    >
      {(Object.keys(FABRIC_PRESETS) as FabricPresetName[]).map((name) => (
        <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, height: 260 }}>
            <div style={{ flex: 2, borderRadius: 10, overflow: 'hidden' }}>
              <FabricSimulator recipe={FABRIC_PRESETS[name]} mode="plane" followPointer />
            </div>
            <div style={{ flex: 1, borderRadius: 10, overflow: 'hidden' }}>
              <FabricSimulator recipe={FABRIC_PRESETS[name]} mode="cylinder" followPointer />
            </div>
          </div>
          <span style={{ color: '#8b8b92', fontSize: 12 }}>{name}</span>
        </div>
      ))}
    </div>
  ),
};
