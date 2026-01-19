/**
 * Google Cloud Secret Manager client.
 *
 * This module provides access to secrets stored in Google Cloud Secret Manager.
 * Secrets are cached in memory to avoid repeated API calls.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { GCP_PROJECT_ID } from './env.server'

// In-memory cache for secrets
const secretCache = new Map<string, string>()

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
