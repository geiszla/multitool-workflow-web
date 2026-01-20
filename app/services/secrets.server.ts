/**
 * Google Cloud Secret Manager client.
 *
 * This module provides access to secrets stored in Google Cloud Secret Manager.
 * Secrets are cached in memory to avoid repeated API calls.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { GCP_PROJECT_ID } from './env.server'

// In-memory cache for secrets with TTL
interface CachedSecret {
  value: string
  expiresAt: number
}

// Permanent cache for non-sensitive secrets (session, OAuth)
const secretCache = new Map<string, string>()

// TTL cache for comped API keys (10 min TTL)
const COMPED_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const compedSecretCache = new Map<string, CachedSecret>()

// Lazy initialization of the Secret Manager client
let client: SecretManagerServiceClient | null = null

function getClient(): SecretManagerServiceClient {
  if (!client) {
    client = new SecretManagerServiceClient()
  }
  return client
}

/**
 * Fetches a secret from Google Cloud Secret Manager.
 * Results are cached in memory for the lifetime of the process.
 *
 * @param secretName - The name of the secret (e.g., "github-client-id")
 * @returns The secret value
 * @throws Error if the secret cannot be fetched
 */
export async function getSecret(secretName: string): Promise<string> {
  // Check cache first
  const cached = secretCache.get(secretName)
  if (cached) {
    return cached
  }

  try {
    const secretClient = getClient()

    // Build the resource name
    const name = `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`

    // Access the secret version
    const [version] = await secretClient.accessSecretVersion({ name })

    // Extract the payload
    const payload = version.payload?.data
    if (!payload) {
      throw new Error(`Secret ${secretName} has no payload`)
    }

    // Convert to string
    const secretValue
      = typeof payload === 'string' ? payload : payload.toString('utf8')

    // Cache the result
    secretCache.set(secretName, secretValue)

    return secretValue
  }
  catch (error) {
    // Never log the actual secret value or full error (may contain request metadata)
    console.error(`Failed to fetch secret "${secretName}":`, error instanceof Error ? error.message : 'Unknown error')
    throw new Error(
      `Failed to fetch secret "${secretName}". Ensure it exists in Secret Manager and the service has access.`,
    )
  }
}

/**
 * Clears the secret cache.
 * Useful for testing or when secrets need to be refreshed.
 */
export function clearSecretCache(): void {
  secretCache.clear()
}

/**
 * Pre-fetches commonly used secrets.
 * Call this during application startup to warm the cache.
 */
export async function prefetchSecrets(): Promise<void> {
  const secretNames = [
    'github-client-id',
    'github-client-secret',
    'session-secret',
  ]

  await Promise.all(secretNames.map(name => getSecret(name)))
}

/**
 * Fetches a comped API key with TTL caching.
 * Comped secrets have a shorter TTL to allow rotation without restart.
 *
 * @param secretName - The name of the secret
 * @returns The secret value
 */
async function getCachedCompedSecret(secretName: string): Promise<string> {
  const cached = compedSecretCache.get(secretName)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  try {
    const secretClient = getClient()
    const name = `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`
    const [version] = await secretClient.accessSecretVersion({ name })

    const payload = version.payload?.data
    if (!payload) {
      throw new Error(`Secret ${secretName} has no payload`)
    }

    const secretValue = typeof payload === 'string' ? payload : payload.toString('utf8')

    compedSecretCache.set(secretName, {
      value: secretValue,
      expiresAt: Date.now() + COMPED_CACHE_TTL_MS,
    })

    return secretValue
  }
  catch (error) {
    // Preserve NOT_FOUND in error message for getOptionalCachedCompedSecret
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`Failed to fetch comped secret "${secretName}":`, errorMessage)
    // Re-throw with original message to preserve NOT_FOUND signal
    if (errorMessage.includes('NOT_FOUND') || errorMessage.includes('not found')) {
      throw new Error(`Secret ${secretName} NOT_FOUND`)
    }
    throw new Error(`Failed to fetch comped secret "${secretName}".`)
  }
}

/**
 * Fetches an optional comped API key with TTL caching.
 * Returns null if the secret doesn't exist (graceful degradation).
 *
 * @param secretName - The name of the secret
 * @returns The secret value or null if not found
 */
async function getOptionalCachedCompedSecret(secretName: string): Promise<string | null> {
  try {
    return await getCachedCompedSecret(secretName)
  }
  catch (error) {
    // Return null if secret doesn't exist
    if (error instanceof Error && (error.message.includes('NOT_FOUND') || error.message.includes('not found'))) {
      return null
    }
    throw error
  }
}

/**
 * Gets the comped Claude API key.
 *
 * @returns The comped Claude API key
 */
export async function getCompedClaudeApiKey(): Promise<string> {
  return getCachedCompedSecret('compedClaudeApiKey')
}

/**
 * Gets the comped Codex API key.
 *
 * @returns The comped Codex API key
 */
export async function getCompedCodexApiKey(): Promise<string> {
  return getCachedCompedSecret('compedCodexApiKey')
}

/**
 * Gets the comped Figma API key (optional).
 *
 * @returns The comped Figma API key or null if not configured
 */
export async function getCompedFigmaApiKey(): Promise<string | null> {
  return getOptionalCachedCompedSecret('compedFigmaApiKey')
}
