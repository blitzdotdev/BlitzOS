import { createAuthClient } from 'better-auth/client'
import { electronClient } from '@better-auth/electron/client'
import { storage } from '@better-auth/electron/storage'
import { organizationClient } from 'better-auth/client/plugins'
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { app, safeStorage } from 'electron'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { isLocalPlatform } from './platform'

const DEV_PLAINTEXT_AUTH_STORAGE_ENV = 'LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE'
const DEV_USER_DATA_DIR_ENV = 'LODY_ELECTRON_USER_DATA_DIR'
const DEV_PLAINTEXT_AUTH_STORAGE_PREFIX = 'lody-dev-plaintext-safe-storage-v1:'

function readNonEmptyEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : null
}

function applyDevUserDataDirIfRequested(): void {
  const userDataDir = readNonEmptyEnv(DEV_USER_DATA_DIR_ENV)
  if (!userDataDir) {
    return
  }

  if (app.isPackaged) {
    console.warn(
      `[Auth] Ignoring ${DEV_USER_DATA_DIR_ENV} because custom userData is only allowed in dev builds.`
    )
    return
  }

  const resolvedUserDataDir = resolve(userDataDir)
  app.setPath('userData', resolvedUserDataDir)
  console.warn(`[Auth] ${DEV_USER_DATA_DIR_ENV}: using ${resolvedUserDataDir}`)
}

function enableDevPlaintextAuthStorageIfRequested(): void {
  if (process.env[DEV_PLAINTEXT_AUTH_STORAGE_ENV] !== '1') {
    return
  }

  if (app.isPackaged) {
    console.warn(
      `[Auth] Ignoring ${DEV_PLAINTEXT_AUTH_STORAGE_ENV}=1 because plaintext auth storage is only allowed in dev builds.`
    )
    return
  }

  try {
    Object.defineProperties(safeStorage, {
      decryptString: {
        configurable: true,
        value: (encrypted: Buffer) => {
          const text = encrypted.toString('utf8')
          return text.startsWith(DEV_PLAINTEXT_AUTH_STORAGE_PREFIX)
            ? text.slice(DEV_PLAINTEXT_AUTH_STORAGE_PREFIX.length)
            : ''
        }
      },
      encryptString: {
        configurable: true,
        value: (plainText: string) =>
          Buffer.from(`${DEV_PLAINTEXT_AUTH_STORAGE_PREFIX}${plainText}`, 'utf8')
      },
      isEncryptionAvailable: {
        configurable: true,
        value: () => true
      }
    })
    console.warn(
      `[Auth] ${DEV_PLAINTEXT_AUTH_STORAGE_ENV}=1: using dev-only plaintext auth storage.`
    )
  } catch (error) {
    console.warn(`[Auth] Failed to enable dev plaintext auth storage`, error)
  }
}

applyDevUserDataDirIfRequested()
enableDevPlaintextAuthStorageIfRequested()

function normalizeConvexSiteUrl(url: string): string {
  if (!url) return url
  try {
    const parsed = new URL(url)
    if (parsed.hostname.endsWith('.convex.cloud')) {
      parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/, '.convex.site')
    }
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

const rawAuthBaseURL =
  import.meta.env.VITE_CONVEX_SITE_URL || import.meta.env.VITE_CONVEX_DEPLOY_URL
// Local platform builds ship without cloud env and the renderer never
// authenticates: keep the auth client constructible against an inert loopback
// base URL so the main process can boot. Cloud builds still require the env.
export const authBaseURL = rawAuthBaseURL
  ? normalizeConvexSiteUrl(rawAuthBaseURL)
  : isLocalPlatform()
    ? 'http://127.0.0.1:0'
    : ''
if (!authBaseURL) {
  throw new Error(
    'VITE_CONVEX_SITE_URL (or VITE_CONVEX_DEPLOY_URL) is required for Electron auth client'
  )
}
const rawAuthStorage = storage()
const authStorage = {
  getItem: (key: string): string | null => {
    const value = rawAuthStorage.getItem(key)
    return typeof value === 'string' ? value : null
  },
  setItem: (key: string, value: unknown): void => {
    rawAuthStorage.setItem(key, value)
  }
}

export const authClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [
    organizationClient(),
    convexClient(),
    crossDomainClient({
      storage: authStorage
    }),
    electronClient({
      signInURL: `${import.meta.env.VITE_SITE_URL || 'https://lody.ai'}/login`,
      protocol: {
        scheme: 'lody'
      },
      storage: authStorage
    })
  ]
})
