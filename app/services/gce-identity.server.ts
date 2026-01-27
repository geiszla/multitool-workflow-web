/**
 * GCE Instance Identity Token Verification Service.
 *
 * Verifies Google Cloud Compute Engine instance identity tokens for
 * VM-to-Cloud Run authentication.
 *
 * These tokens are JWTs signed by Google and contain claims about the
 * VM instance, including the service account and instance metadata.
 *
 * @see https://cloud.google.com/compute/docs/instances/verifying-instance-identity
 */

import { OAuth2Client } from 'google-auth-library'
import { env, GCP_PROJECT_ID } from './env.server'

/**
 * Claims extracted from a verified GCE identity token.
 */
export interface GceIdentityClaims {
  // Standard JWT claims
  iss: string // Issuer (accounts.google.com)
  sub: string // Subject (service account unique ID)
  aud: string // Audience (our Cloud Run URL)
  iat: number // Issued at
  exp: number // Expiry

  // GCE-specific claims
  azp: string // Authorized party (service account email)
  email: string // Service account email
  email_verified: boolean

  // GCE compute metadata (optional, depends on token format)
  google?: {
    compute_engine?: {
      project_id?: string
      project_number?: string | number
      zone?: string
      instance_id?: string
      instance_name?: string
      instance_creation_timestamp?: number
    }
  }
}

/**
 * Result of token verification.
 */
export interface VerificationResult {
  valid: boolean
  claims?: GceIdentityClaims
  error?: string
}

// Singleton OAuth2Client for cryptographic JWT verification
const oauthClient = new OAuth2Client()

// Expected service account email for agent VMs
const EXPECTED_SERVICE_ACCOUNT_EMAIL = `agent-vm@${GCP_PROJECT_ID}.iam.gserviceaccount.com`

/**
 * Verifies a GCE instance identity token using cryptographic verification.
 *
 * Uses OAuth2Client.verifyIdToken() for proper JWT signature verification
 * instead of the tokeninfo endpoint.
 *
 * @param token - The identity token from the Authorization header
 * @param expectedAudience - The expected audience (our Cloud Run URL)
 * @returns Verification result with claims if valid
 */
export async function verifyGceIdentityToken(
  token: string,
  expectedAudience?: string,
): Promise<VerificationResult> {
  try {
    const audience = expectedAudience || env.APP_URL

    // Cryptographic verification (fetches Google certs, verifies signature)
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience,
    })

    const payload = ticket.getPayload()
    if (!payload) {
      return { valid: false, error: 'No payload in token' }
    }

    // Post-verification claim validation (fail closed)
    // 1. Verify issuer
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      return { valid: false, error: `Invalid issuer: ${payload.iss}` }
    }

    // 2. Verify email (exact match, not prefix)
    if (payload.email !== EXPECTED_SERVICE_ACCOUNT_EMAIL || !payload.email_verified) {
      return { valid: false, error: `Invalid service account: ${payload.email}` }
    }

    // 3. Require GCE claims (enforces format=full)
    const gceClaims = (payload as GceIdentityClaims).google?.compute_engine
    if (!gceClaims?.instance_name) {
      return { valid: false, error: 'Missing GCE instance metadata (format=full required)' }
    }

    return { valid: true, claims: payload as GceIdentityClaims }
  }
  catch (error) {
    return {
      valid: false,
      error: `Token verification error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/**
 * Validates that a VM instance belongs to a specific agent.
 *
 * Security: This function ensures that VMs can only access resources
 * for the agent they were created for, preventing unauthorized access
 * to other agents' credentials or status.
 *
 * Defense in depth: Also validates zone to prevent cross-zone impersonation,
 * since instance names are only unique within a zone.
 *
 * @param storedInstanceName - Instance name stored in Firestore (source of truth)
 * @param claims - Verified GCE identity claims
 * @param storedInstanceZone - Optional zone stored in Firestore (for additional validation)
 * @returns True if the instance is authorized for this agent
 */
export function validateInstanceForAgent(
  storedInstanceName: string | undefined,
  claims: GceIdentityClaims,
  storedInstanceZone?: string,
): boolean {
  const gceClaims = claims.google?.compute_engine
  const instanceName = gceClaims?.instance_name
  const instanceZone = gceClaims?.zone

  if (!instanceName) {
    // If instance metadata is not available, we cannot verify
    // This is a security-sensitive situation - fail closed
    console.warn('GCE identity: Instance name not found in claims')
    return false
  }

  if (!storedInstanceName) {
    // If we don't have a stored instance name to compare against, fail closed
    console.warn('GCE identity: No stored instance name to validate against')
    return false
  }

  // Verify the instance name from token matches the stored instance name (source of truth)
  if (instanceName !== storedInstanceName) {
    console.warn(`GCE identity: Instance name mismatch. Expected ${storedInstanceName}, got ${instanceName}`)
    return false
  }

  // Defense in depth: If we have a stored zone, verify it matches
  // Instance names are only unique within a zone, so this prevents cross-zone impersonation
  if (storedInstanceZone) {
    if (!instanceZone) {
      // If we expect a zone but token doesn't have one, fail closed
      console.warn('GCE identity: Zone validation required but token has no zone claim')
      return false
    }
    // Zone format in token: "projects/PROJECT_NUM/zones/ZONE_NAME"
    // We only need to compare the zone name portion
    const tokenZoneName = instanceZone.split('/').pop()
    if (tokenZoneName !== storedInstanceZone) {
      console.warn(`GCE identity: Zone mismatch. Expected ${storedInstanceZone}, got ${tokenZoneName}`)
      return false
    }
  }

  return true
}

/**
 * Extracts and validates agent ID from request.
 * Verifies that the requesting VM instance is authorized for this agent.
 *
 * Note: This function now requires the storedInstanceName to be passed in,
 * as it performs authorization binding against the Firestore source of truth.
 * Callers must fetch the agent first and pass agent.instanceName and agent.instanceZone.
 *
 * @param params - Route params containing the agent ID
 * @param params.id - Optional agent ID from URL
 * @param claims - Verified GCE identity claims
 * @param storedInstanceName - Instance name from Firestore (source of truth)
 * @param storedInstanceZone - Optional zone from Firestore (for additional validation)
 * @returns Agent ID if valid and authorized, null otherwise
 */
export function extractAgentId(
  params: { id?: string },
  claims: GceIdentityClaims,
  storedInstanceName?: string,
  storedInstanceZone?: string,
): string | null {
  const agentId = params.id
  if (!agentId) {
    return null
  }

  // Validate that this VM instance is authorized to access this agent
  if (!validateInstanceForAgent(storedInstanceName, claims, storedInstanceZone)) {
    console.warn(`GCE identity: VM not authorized for agent ${agentId}`)
    return null
  }

  return agentId
}

/**
 * Extracts the bearer token from an Authorization header.
 *
 * @param authHeader - The Authorization header value
 * @returns The token or null if invalid format
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null
  }

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null
  }

  return parts[1]
}
