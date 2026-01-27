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
 * on itself. Grant the "Service Account Token Creator" role:
 *
 *   gcloud iam service-accounts add-iam-policy-binding \
 *     PROJECT_NUMBER-compute@developer.gserviceaccount.com \
 *     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
 *     --role="roles/iam.serviceAccountTokenCreator"
 */

import { GoogleAuth } from 'google-auth-library'
import { GCP_PROJECT_ID } from './env.server'

// Service account email for signing tokens
// Uses the default Cloud Run service account
let serviceAccountEmail: string | null = null

// Lazy-initialized auth client
let authClient: GoogleAuth | null = null

function getAuthClient(): GoogleAuth {
  if (!authClient) {
    authClient = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
  }
  return authClient
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
    serviceAccountEmail = `${GCP_PROJECT_ID}@appspot.gserviceaccount.com`
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

  const auth = getAuthClient()
  const saEmail = await getServiceAccountEmail()

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

  // Use IAM Credentials API signJwt endpoint
  // The signJwt endpoint expects a JSON string claim-set (not header.payload)
  // It handles the JWT header and signature internally
  const iamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:signJwt`

  const accessToken = await auth.getAccessToken()
  const response = await fetch(iamUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payload: JSON.stringify(claimSet), // JSON string of claim-set, NOT header.payload
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    // Provide helpful error message for common IAM permission issue
    if (response.status === 403) {
      throw new Error(
        `Failed to sign token: ${response.status} ${text}. `
        + `Ensure the service account has "Service Account Token Creator" role. `
        + `Run: gcloud iam service-accounts add-iam-policy-binding ${saEmail} `
        + `--member="serviceAccount:${saEmail}" --role="roles/iam.serviceAccountTokenCreator"`,
      )
    }
    throw new Error(`Failed to sign token: ${response.status} ${text}`)
  }

  // Response contains the complete JWT (header + payload + signature)
  const data = await response.json() as { signedJwt: string }
  return data.signedJwt
}
