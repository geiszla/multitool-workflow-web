/**
 * Firebase Admin Service.
 *
 * Generates custom Firebase tokens for authenticated users.
 * Uses Google Auth Library instead of firebase-admin for simpler dependency management.
 *
 * Security:
 * - Only generates tokens for authenticated users
 * - Token UID matches internal user ID
 * - Uses service account for signing
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

  // Sign the token using the service account
  const client = await auth.getClient()

  // For service account credentials, we can sign JWTs directly
  // For default credentials in Cloud Run, we need to use the IAM API
  if ('sign' in client) {
    // IAM credentials API signing
    const headerBase64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signatureInput = `${headerBase64}.${payloadBase64}`

    // Use IAM API to sign the token
    const iamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:signBlob`

    const accessToken = await auth.getAccessToken()
    const response = await fetch(iamUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload: Buffer.from(signatureInput).toString('base64'),
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to sign token: ${response.status} ${text}`)
    }

    const data = await response.json() as { signedBlob: string }
    const signature = Buffer.from(data.signedBlob, 'base64').toString('base64url')

    return `${signatureInput}.${signature}`
  }

  // Fallback: Use JWT client if available
  throw new Error('Unable to sign custom token: no signing method available')
}
