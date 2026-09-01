import { Command } from 'commander';
import chalk from 'chalk';
import { getLogger, rootLogger } from '../utils/logger';
import { reportError } from '../utils/telemetry';
import {
  AuthClient,
  isMachinePairingCredential,
  isRetryableTokenValidationFailure,
  isTokenValidationUnavailable,
  performLogin,
  performLoginWithAuthCredential,
} from '@/lib/auth';
import { flushTelemetry } from '@/instrument';
import { captureAuthEvent } from './analytics-events';

interface LoginOptions {
  debug?: boolean;
  machineName?: string;
  auth?: string;
}

/** Flush analytics, then exit. Login is a one-shot command. */
async function exitLogin(code: number): Promise<never> {
  await flushTelemetry();
  process.exit(code);
}

export const loginCommand = new Command('login')
  .description('Login to Lody using device authorization flow or an API key')
  .option('-d, --debug', 'enable debug output')
  .option('--machine-name <name>', 'Machine name to register (defaults to hostname)')
  .option('--auth <credential>', 'Log in with a CLI API key or machine connection token')
  .action(async (options: LoginOptions) => {
    if (options.debug) {
      rootLogger.setDebug(true);
    }
    const logger = getLogger('login');

    const authClient = new AuthClient(logger);
    const providedAuth = options.auth?.trim();
    const authMethod = providedAuth
      ? isMachinePairingCredential(providedAuth)
        ? 'machine_pairing'
        : 'api_key'
      : 'device_auth';

    try {
      if (options.auth !== undefined && !providedAuth) {
        captureAuthEvent('login_failed', {
          auth_method: 'api_key',
          reason_code: 'missing_api_key',
        });
        logger.error('Missing credential for --auth.');
        await exitLogin(1);
      }

      captureAuthEvent('login_started', { auth_method: authMethod });

      if (providedAuth) {
        const result = await performLoginWithAuthCredential(authClient, logger, {
          credential: providedAuth,
          machineName: options.machineName,
        });

        if (result.success) {
          captureAuthEvent('login_succeeded', { auth_method: authMethod });
          logger.success('\n' + chalk.green('✓') + ' Successfully logged in!');
          logger.info('  User: ' + chalk.cyan(result.user.name || result.user.email));
          logger.info('  Email: ' + chalk.cyan(result.user.email));
        } else {
          captureAuthEvent('login_failed', { auth_method: authMethod });
          await reportError('login', result.error, {
            message: 'Login failed using --auth',
            logger,
          });
          await exitLogin(1);
        }
        await flushTelemetry();
        return;
      }

      // 检查是否已经登录
      const existingAuth = authClient.getAuthInfo();
      if (existingAuth) {
        logger.debug('Found existing authentication, checking validity...');
        const validation = await authClient.validateToken(existingAuth.token);
        if (validation.valid && validation.user) {
          captureAuthEvent('login_succeeded', {
            auth_method: 'device_auth',
            already_logged_in: true,
          });
          logger.success('\n' + chalk.green('✓') + ' You are already logged in!');
          logger.info('  User: ' + chalk.cyan(validation.user.name || validation.user.email));
          logger.info('  Email: ' + chalk.cyan(validation.user.email));
          await flushTelemetry();
          return;
        } else if (isRetryableTokenValidationFailure(validation)) {
          captureAuthEvent('login_failed', {
            auth_method: 'device_auth',
            reason_code: 'auth_service_unreachable',
          });
          logger.error(
            `Unable to validate existing authentication because the auth service is unreachable: ${validation.error ?? 'network error'}`
          );
          await exitLogin(1);
        } else if (isTokenValidationUnavailable(validation)) {
          captureAuthEvent('login_failed', {
            auth_method: 'device_auth',
            reason_code: 'auth_validation_unavailable',
          });
          logger.error(
            `Unable to validate existing authentication: ${validation.error ?? validation.reason}`
          );
          await exitLogin(1);
        } else {
          logger.debug('Existing authentication is invalid, proceeding with new login...');
        }
      }

      // 执行登录流程（包括机器名称提示）
      logger.info('Initializing device authorization...');
      const result = await performLogin(authClient, logger, { machineName: options.machineName });

      if (result.success) {
        captureAuthEvent('login_succeeded', { auth_method: 'device_auth' });
        logger.success('\n' + chalk.green('✓') + ' Successfully logged in!');
        logger.info('  User: ' + chalk.cyan(result.user.name || result.user.email));
        logger.info('  Email: ' + chalk.cyan(result.user.email));
      } else {
        captureAuthEvent('login_failed', { auth_method: 'device_auth' });
        await reportError('login', result.error, {
          message: 'Login failed during device authorization',
          logger,
        });
        await exitLogin(1);
      }
      await flushTelemetry();
    } catch (error) {
      captureAuthEvent('login_failed', { auth_method: authMethod, reason_code: 'exception' });
      await reportError('login', error, {
        message: 'Login command failed',
        logger,
      });
      await exitLogin(1);
    }
  });
