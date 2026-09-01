import path from 'path';
import packageJson from '@/pkg';
import {
  checkClaude,
  checkCodex,
  checkKimi,
  checkOpencode,
  __test__,
} from '@lody/shared/node/cli-detection';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

export const getLodyCLIVersion = () => {
  return packageJson.version;
};

/**
 * 获取配置文件路径
 */
export function getConfigPath(): string {
  return path.join(getLodyDataDir(), 'credentials.json');
}

export { checkClaude, checkCodex, checkKimi, checkOpencode, __test__ };
