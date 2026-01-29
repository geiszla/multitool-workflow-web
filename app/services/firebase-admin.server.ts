/**
 * Firebase Admin Service.
 *
 * Generates custom Firebase tokens for authenticated users.
 * Uses Google IAM Credentials API for signing, which works reliably in Cloud Run.
 *
 * Security:
 * - Only generates tokens for authenticated users
 * - Token UID matches internal user ID
 * - Uses service account for signing via IAM API
 *
 * Required IAM Permission:
 * The Cloud Run service account needs `iam.serviceAccounts.signJwt` permission
 * on itself. Grant the "Service Account Token Creator" role.
 */

import { IAMCredentialsClient } from '@google-cloud/iam-credentials'
import { GoogleAuth } from 'google-auth-library'
import { GCP_PROJECT_ID } from './env.server'

// Service account email for signing tokens
// Uses the default Cloud Run service account
let serviceAccountEmail: string | null = null

// Lazy-initialized clients
let authClient: GoogleAuth | null = null
let iamCredentialsClient: IAMCredentialsClient | null = null

function getAuthClient(): GoogleAuth {
  if (!authClient) {
    authClient = new GoogleAuth()
  }
  return authClient
}

function getIAMCredentialsClient(): IAMCredentialsClient {
  if (!iamCredentialsClient) {
    iamCredentialsClient = new IAMCredentialsClient()
  }
  return iamCredentialsClient
}

/**
 * Gets the service account email for the current environment.
 */
async function getServiceAccountEmail(): Promise<string> {
  if (serviceAccountEmail) {
    return serviceAccountEmail
  }

  const auth = getAuthClient()
  const credentials = await auth.getCredentials()

  if (credentials.client_email) {
    serviceAccountEmail = credentials.client_email
  }
  else {
    // In production Cloud Run, this will be the default service account
    serviceAccountEmail = `cloud-run-app@${GCP_PROJECT_ID}.iam.gserviceaccount.com`
  }

  return serviceAccountEmail
}

/**
 * Creates a Firebase custom token for a user.
 *
 * This token can be used with Firebase client SDK's signInWithCustomToken()
 * to authenticate the user to Firebase and enable Firestore realtime subscriptions.
 *
 * Uses the IAM Credentials API signJwt method which is purpose-built for this
 * use case and works reliably in Cloud Run without requiring a service account
 * key file.
 *
 * @param uid - User ID (will be the Firebase UID)
 * @param claims - Optional custom claims
 * @returns Custom token string
 */
export async function createCustomToken(
  uid: string,
  claims?: Record<string, unknown>,
): Promise<string> {
  // Validate uid
  if (!uid || typeof uid !== 'string') {
    throw new Error('uid must be a non-empty string')
  }
  if (uid.length > 128) {
    throw new Error('uid must be 128 characters or less')
  }

  // Validate claims don't contain reserved keys
  if (claims) {
    const reservedKeys = ['iss', 'sub', 'aud', 'iat', 'exp', 'uid']
    for (const key of reservedKeys) {
      if (key in claims) {
        throw new Error(`claims cannot contain reserved key: ${key}`)
      }
    }
  }

  const saEmail = await getServiceAccountEmail()
  const client = getIAMCredentialsClient()

  const now = Math.floor(Date.now() / 1000)

  // Build the claim-set as a JSON object
  // Firebase custom tokens require this specific structure
  const claimSet = {
    iss: saEmail,
    sub: saEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600, // 1 hour (Firebase max)
    uid,
    claims, // Custom claims go inside 'claims' object
  }

  // Use IAM Credentials API signJwt method
  // The client handles authentication automatically via ADC
  try {
    const [response] = await client.signJwt({
      name: `projects/-/serviceAccounts/${saEmail}`,
      payload: JSON.stringify(claimSet),
    })

    if (!response.signedJwt) {
      throw new Error('signJwt returned empty response')
    }

    return response.signedJwt
  }
  catch (error) {
    // Provide helpful error message for common IAM permission issue
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('403') || message.includes('PERMISSION_DENIED')) {
      throw new Error(
        `Failed to sign token: ${message}. `
        + `Ensure the service account has "Service Account Token Creator" role. `
        + `Run: gcloud iam service-accounts add-iam-policy-binding ${saEmail} `
        + `--member="serviceAccount:${saEmail}" --role="roles/iam.serviceAccountTokenCreator"`,
      )
    }
    throw error
  }
}
