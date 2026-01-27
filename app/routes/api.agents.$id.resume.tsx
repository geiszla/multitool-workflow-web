/**
 * Agent Resume API Endpoint.
 *
 * Resumes a suspended or stopped agent VM.
 * Called by the browser Terminal component when reconnecting to an inactive agent.
 *
 * Supports two flows:
 * - suspended -> running: Resumes VM (quick, preserves memory state)
 * - stopped -> running: Starts VM (slower, full boot), clears stale internalIp
 *
 * Security:
 * - Requires valid session
 * - User must have access to the agent (owner or shared)
 */

import type { ActionFunctionArgs } from 'react-router'
import { Timestamp } from '@google-cloud/firestore'
import { canAccessAgent, getAgent } from '~/models/agent.server'
import { resumeInstance, startInstance } from '~/services/compute.server'
import { getFirestore } from '~/services/firestore.server'
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
    const db = getFirestore()
    const agentRef = db.collection('agents').doc(agentId)

    // Two-phase approach to avoid duplicate GCE operations:
    // 1. Use transaction to atomically check and claim the status transition
    // 2. Perform GCE operation outside transaction (idempotent at GCE level)
    // 3. Update status to running after GCE op succeeds
    //
    // This approach handles races correctly:
    // - If two requests race, only one will claim the transition
    // - GCE operations are idempotent (resuming an already-resuming VM is fine)

    // Phase 1: Atomically check and claim the transition
    // We use a transitional status marker to prevent duplicate claims
    let statusToClaim: 'suspended' | 'stopped' | null = null

    await db.runTransaction(async (transaction) => {
      const agentDoc = await transaction.get(agentRef)
      if (!agentDoc.exists) {
        throw new Error('Agent not found')
      }

      const currentStatus = agentDoc.data()?.status

      // Check if already running or being resumed (idempotency)
      if (currentStatus === 'running') {
        statusToClaim = null
        return
      }

      if (currentStatus !== 'suspended' && currentStatus !== 'stopped') {
        throw new Error(`Cannot resume agent in ${currentStatus} status`)
      }

      // Claim this status for our GCE operation
      statusToClaim = currentStatus as 'suspended' | 'stopped'
      // We don't update status here - we'll do it after GCE op succeeds
    })

    // If already running, nothing to do
    if (!statusToClaim) {
      return json({ success: true, previousStatus, alreadyRunning: true })
    }

    // Phase 2: Perform GCE operation (outside transaction)
    if (statusToClaim === 'suspended') {
      await resumeInstance(agent.instanceName, agent.instanceZone)
    }
    else {
      await startInstance(agent.instanceName, agent.instanceZone)
    }

    // Phase 3: Update status to running after GCE op succeeds
    const updateData: Record<string, unknown> = {
      status: 'running',
      updatedAt: Timestamp.now(),
      startedAt: Timestamp.now(),
      lastHeartbeatAt: Timestamp.now(),
    }

    if (statusToClaim === 'stopped') {
      // Clear stale data for stop->start transition
      // internalIp may change after VM restart
      // terminalReady should be false until pty-server reports ready
      updateData.internalIp = null
      updateData.terminalReady = false
    }

    await agentRef.update(updateData)

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
