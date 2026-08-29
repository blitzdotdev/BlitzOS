export type RuntimeEnv = 'dev' | 'staging' | 'production';

const normalizeRuntimeEnv = (value?: string): RuntimeEnv => {
  switch (value?.toLowerCase()) {
    case 'dev':
    case 'development':
      return 'dev';
    case 'prod':
    case 'production':
      return 'production';
    case 'stage':
    case 'staging':
      return 'staging';
    default:
      return 'dev';
  }
};

export const getRuntimeEnv = (): RuntimeEnv =>
  normalizeRuntimeEnv(process.env.LODY_ENV ?? process.env.NODE_ENV);

export const isDevEnv = (): boolean => getRuntimeEnv() === 'dev';
