/**
 * Agent Resume API Endpoint.
 *
 * Resumes a suspended or stopped agent VM.
 * Called by the browser Terminal component when reconnecting to an inactive agent.
 *
 * Supports two flows:
 * - suspended -> running: Resumes VM (quick, preserves memory state)
 * - stopped -> running: Starts VM (slower, full boot)
 *
 * Note: internalIp is NOT stored in Firestore - always fetched on-demand from GCE.
 *
 * Security:
 * - Requires valid session
 * - User must have access to the agent (owner or shared)
 */

import type { ActionFunctionArgs } from 'react-router'
import { canAccessAgent, getAgent, updateAgentStatus } from '~/models/agent.server'
import { resumeInstance, startInstance } from '~/services/compute.server'
import { requireUser } from '~/services/session.server'

/**
 * Helper to create JSON responses.
 */
function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init)
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Only allow POST requests
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
    // Verify user can access the agent
    const hasAccess = await canAccessAgent(agentId, user.id)
    if (!hasAccess) {
      return json({ error: 'Access denied' }, { status: 403 })
    }

    // Get agent to check status and instance info
    const agent = await getAgent(agentId)
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    // Only allow resuming suspended or stopped agents
    if (agent.status !== 'suspended' && agent.status !== 'stopped') {
      return json({ error: `Cannot resume agent in ${agent.status} status` }, { status: 400 })
    }

    // Ensure we have instance info
    if (!agent.instanceName || !agent.instanceZone) {
      return json({ error: 'Agent instance not found' }, { status: 400 })
    }

    const previousStatus = agent.status
    const statusToClaim = agent.status as 'suspended' | 'stopped'

    // Perform GCE operation first (idempotent at GCE level)
    // If this fails, we don't update Firestore
    if (statusToClaim === 'suspended') {
      await resumeInstance(agent.instanceName, agent.instanceZone)
    }
    else {
      await startInstance(agent.instanceName, agent.instanceZone)
    }

    // Use state machine for status transition (provides optimistic locking)
    try {
      await updateAgentStatus(
        agentId,
        statusToClaim,
        'running',
        {
          terminalReady: false, // Reset until pty-server reports ready
          needsResume: false, // Clear flag on successful transition
          // NOTE: internalIp is NOT stored in Firestore - fetched on-demand from GCE
        },
      )
    }
    catch (error) {
      // Handle 409 conflict - re-fetch to check actual status
      const statusError = error as Error & { status?: number }
      if (statusError.status === 409) {
        // Re-fetch agent to see what actually happened
        const refreshedAgent = await getAgent(agentId)
        if (refreshedAgent?.status === 'running') {
          // Someone else already resumed - this is a success case
          return json({ success: true, previousStatus, alreadyRunning: true })
        }
        // Status changed to something else (stopped, failed) - report actual error
        return json({
          error: `Agent status changed to ${refreshedAgent?.status ?? 'unknown'}`,
        }, { status: 409 })
      }
      throw error
    }

    return json({ success: true, previousStatus })
  }
  catch (error) {
    console.error('Failed to resume agent:', error instanceof Error ? error.message : 'Unknown error')
    return json({ error: 'Failed to resume agent' }, { status: 500 })
  }
}

// GET returns method not allowed
export async function loader() {
  return json({ error: 'Method not allowed' }, { status: 405 })
}

// No UI for API routes
export default function ResumeApi() {
  return null
}
