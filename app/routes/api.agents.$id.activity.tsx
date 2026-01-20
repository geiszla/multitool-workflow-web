/**
 * Agent Activity API Endpoint.
 *
 * Updates the lastActivity timestamp for an agent.
 * Called by the browser InactivityManager to track user activity.
 *
 * Security:
 * - Requires valid session
 * - User must own the agent
 */

import type { Route } from './+types/api.agents.$id.activity'
import { getAgentForUser, updateAgentActivity } from '~/models/agent.server'
import { requireUser } from '~/services/session.server'

/**
 * Helper to create JSON responses.
 */
function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init)
}

export async function loader() {
  // Only POST is allowed
  return json({ error: 'Method not allowed' }, { status: 405 })
}

export async function action({ request, params }: Route.ActionArgs) {
  // Only allow POST
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 })
  }

  // Require authenticated user
  const user = await requireUser(request)
  const agentId = params.id

  if (!agentId) {
    return json({ error: 'Agent ID is required' }, { status: 400 })
  }

  try {
    // Verify user owns the agent
    const agent = await getAgentForUser(agentId, user.id)

    // Only update activity for running agents
    if (agent.status !== 'running') {
      return json({ error: 'Agent is not running' }, { status: 400 })
    }

    // Update the lastActivity timestamp
    await updateAgentActivity(agentId)

    return json({ success: true })
  }
  catch (error) {
    const statusError = error as Error & { status?: number }
    if (statusError.status === 404) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }
    if (statusError.status === 403) {
      return json({ error: 'Access denied' }, { status: 403 })
    }
    console.error('Failed to update agent activity:', error instanceof Error ? error.message : 'Unknown error')
    return json({ error: 'Failed to update activity' }, { status: 500 })
  }
}

// No UI for API routes
export default function AgentActivityApi() {
  return null
}
