/**
 * Agent Credentials API Endpoint.
 *
 * Provides secure endpoint for VM to fetch credentials needed for operation:
 * - GitHub OAuth token (for repo cloning)
 * - Claude API key (for code generation)
 * - Codex API key (optional, for code review)
 * - Resume flag (if agent needs --resume flag)
 *
 * Security:
 * - Authenticates via GCE instance identity token
 * - Verifies agent exists and belongs to the correct user
 * - Credentials are not cached on VM disk
 * - Logs access without exposing credentials
 */

import type { Route } from './+types/api.agents.$id.credentials'
import { getAgent } from '~/models/agent.server'
import { getExternalAuth } from '~/models/external-auth.server'
import { getUserById } from '~/models/user.server'
import {
  extractAgentId,
  extractBearerToken,
  verifyGceIdentityToken,
} from '~/services/gce-identity.server'
import {
  getCompedClaudeApiKey,
  getCompedCodexApiKey,
  getCompedFigmaApiKey,
} from '~/services/secrets.server'

/**
 * Helper to create JSON responses.
 */
function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init)
}

/**
 * Credentials response structure.
 */
interface CredentialsResponse {
  githubToken?: string
  claudeApiKey?: string
  codexApiKey?: string
  figmaApiKey?: string
  needsResume?: boolean
  repoOwner: string
  repoName: string
  branch: string
  issueNumber?: number
  instructions?: string
}

export async function loader({ request, params }: Route.LoaderArgs) {
  // Extract and verify the GCE identity token
  const authHeader = request.headers.get('Authorization')
  const token = extractBearerToken(authHeader)

  if (!token) {
    console.warn('Credentials API: Missing authorization token')
    return json({ error: 'Missing authorization token' }, { status: 401 })
  }

  const verification = await verifyGceIdentityToken(token)

  if (!verification.valid || !verification.claims) {
    console.warn('Credentials API: Invalid token:', verification.error)
    return json({ error: verification.error || 'Invalid token' }, { status: 401 })
  }

  // Extract agent ID from params
  const agentId = extractAgentId(params, verification.claims)

  if (!agentId) {
    console.warn('Credentials API: Missing agent ID')
    return json({ error: 'Missing agent ID' }, { status: 400 })
  }

  // Fetch agent from Firestore
  const agent = await getAgent(agentId)

  if (!agent) {
    console.warn(`Credentials API: Agent not found: ${agentId}`)
    return json({ error: 'Agent not found' }, { status: 404 })
  }

  // Verify agent is in a valid state (provisioning or running)
  if (!['provisioning', 'running'].includes(agent.status)) {
    console.warn(`Credentials API: Agent ${agentId} in invalid state: ${agent.status}`)
    return json({ error: `Agent in invalid state: ${agent.status}` }, { status: 400 })
  }

  // Log access (without credentials)
  // eslint-disable-next-line no-console
  console.log(`Credentials API: Fetching credentials for agent ${agentId}, user ${agent.userId}`)

  // Fetch user to check if they're comped
  const user = await getUserById(agent.userId)
  const isComped = user?.isComped ?? false

  // Fetch credentials for the agent's owner
  // GitHub token always comes from user's external auth
  const githubToken = await getExternalAuth(agent.userId, 'github')

  if (!githubToken) {
    console.error(`Credentials API: No GitHub token for user ${agent.userId}`)
    return json({ error: 'GitHub token not configured' }, { status: 500 })
  }

  let claudeApiKey: string | null
  let codexApiKey: string | null
  let figmaApiKey: string | null

  if (isComped) {
    // Comped users get org API keys from Secret Manager
    // eslint-disable-next-line no-console
    console.log(`Credentials API: Using comped API keys for user ${agent.userId}`)
    try {
      claudeApiKey = await getCompedClaudeApiKey()
      codexApiKey = await getCompedCodexApiKey()
      // For Figma, try comped first, fall back to user's own token
      figmaApiKey = await getCompedFigmaApiKey() ?? await getExternalAuth(agent.userId, 'figma')
    }
    catch (error) {
      console.error(`Credentials API: Failed to fetch comped API keys:`, error instanceof Error ? error.message : 'Unknown error')
      return json({ error: 'Failed to fetch organization API keys' }, { status: 500 })
    }
  }
  else {
    // Regular users use their own API keys
    const [claude, codex, figma] = await Promise.all([
      getExternalAuth(agent.userId, 'claude'),
      getExternalAuth(agent.userId, 'codex'),
      getExternalAuth(agent.userId, 'figma'),
    ])
    claudeApiKey = claude
    codexApiKey = codex
    figmaApiKey = figma
  }

  if (!claudeApiKey) {
    console.error(`Credentials API: No Claude API key for user ${agent.userId}`)
    return json({ error: 'Claude API key not configured' }, { status: 500 })
  }

  const response: CredentialsResponse = {
    githubToken,
    claudeApiKey,
    codexApiKey: codexApiKey ?? undefined,
    figmaApiKey: figmaApiKey ?? undefined,
    needsResume: agent.needsResume,
    repoOwner: agent.repoOwner,
    repoName: agent.repoName,
    branch: agent.branch,
    issueNumber: agent.issueNumber,
    instructions: agent.instructions,
  }

  // Return with Cache-Control header to prevent caching of sensitive credentials
  return json(response, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  })
}

// Only GET is allowed
export function action() {
  return json({ error: 'Method not allowed' }, { status: 405 })
}

// No UI for API routes
export default function CredentialsApi() {
  return null
}
