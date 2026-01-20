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

import { env } from './env.server'

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

// Google OAuth2 token info endpoint
const TOKEN_INFO_URL = 'https://oauth2.googleapis.com/tokeninfo'

// Expected service account for agent VMs
const AGENT_SERVICE_ACCOUNT_PREFIX = 'agent-vm@'

/**
 * Verifies a GCE instance identity token.
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
    // Use Google's tokeninfo endpoint to verify the token
    // This is simpler than verifying the JWT signature ourselves
    const response = await fetch(`${TOKEN_INFO_URL}?id_token=${encodeURIComponent(token)}`)

    if (!response.ok) {
      const text = await response.text()
      return {
        valid: false,
        error: `Token verification failed: ${response.status} ${text}`,
      }
    }

    const claims = await response.json() as GceIdentityClaims

    // Verify audience matches our expected audience
    const audience = expectedAudience || env.APP_URL
    if (claims.aud !== audience) {
      return {
        valid: false,
        error: `Invalid audience: expected ${audience}, got ${claims.aud}`,
      }
    }

    // Verify issuer
    if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') {
      return {
        valid: false,
        error: `Invalid issuer: ${claims.iss}`,
      }
    }

    // Verify service account is our agent VM account
    if (!claims.email?.startsWith(AGENT_SERVICE_ACCOUNT_PREFIX)) {
      return {
        valid: false,
        error: `Invalid service account: ${claims.email}`,
      }
    }

    // Verify token hasn't expired (with 30 second leeway)
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp < now - 30) {
      return {
        valid: false,
        error: 'Token expired',
      }
    }

    return {
      valid: true,
      claims,
    }
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
 * @param agentId - Agent UUID from URL params
 * @param claims - Verified GCE identity claims
 * @returns True if the instance is authorized for this agent
 */
export function validateInstanceForAgent(
  agentId: string,
  claims: GceIdentityClaims,
): boolean {
  // The instance name is formatted as "agent-{first8chars}" in compute.server.ts
  const expectedInstancePrefix = `agent-${agentId.slice(0, 8)}`
  const instanceName = claims.google?.compute_engine?.instance_name

  if (!instanceName) {
    // If instance metadata is not available, we cannot verify
    // This is a security-sensitive situation - fail closed
    console.warn('GCE identity: Instance name not found in claims')
    return false
  }

  // Verify the instance name matches the expected pattern for this agent
  if (instanceName !== expectedInstancePrefix) {
    console.warn(`GCE identity: Instance name mismatch. Expected ${expectedInstancePrefix}, got ${instanceName}`)
    return false
  }

  return true
}

/**
 * Extracts and validates agent ID from request.
 * Verifies that the requesting VM instance is authorized for this agent.
 *
 * @param params - Route params containing the agent ID
 * @param params.id - Optional agent ID from URL
 * @param claims - Verified GCE identity claims
 * @returns Agent ID if valid and authorized, null otherwise
 */
export function extractAgentId(
  params: { id?: string },
  claims: GceIdentityClaims,
): string | null {
  const agentId = params.id
  if (!agentId) {
    return null
  }

  // Validate that this VM instance is authorized to access this agent
  if (!validateInstanceForAgent(agentId, claims)) {
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
