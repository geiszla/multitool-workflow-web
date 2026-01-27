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

import { Buffer } from 'node:buffer'
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
 * Firebase custom token payload.
 */
interface CustomTokenPayload {
  iss: string // Issuer (service account email)
  sub: string // Subject (service account email)
  aud: string // Audience (Firebase token endpoint)
  iat: number // Issued at
  exp: number // Expiry (1 hour)
  uid: string // User ID in Firebase
  claims?: Record<string, unknown> // Custom claims
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
  const auth = getAuthClient()
  const saEmail = await getServiceAccountEmail()

  const now = Math.floor(Date.now() / 1000)
  const payload: CustomTokenPayload = {
    iss: saEmail,
    sub: saEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600, // 1 hour
    uid,
    claims,
  }

  // Create JWT header and payload
  const headerBase64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signatureInput = `${headerBase64}.${payloadBase64}`

  // Use IAM Credentials API signJwt endpoint (purpose-built for JWT signing)
  // This is more reliable than signBlob as it handles the JWT structure correctly
  const iamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:signJwt`

  const accessToken = await auth.getAccessToken()
  const response = await fetch(iamUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payload: signatureInput,
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

  const data = await response.json() as { signedJwt: string }
  return data.signedJwt
}
