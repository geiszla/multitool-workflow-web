/**
 * Agent Status Update API Endpoint.
 *
 * Allows VM to update its status in Firestore.
 * Used by the agent-bootstrap and pty-server services to report their state.
 *
 * Security:
 * - Authenticates via GCE instance identity token
 * - Uses Firestore transaction with statusVersion check (optimistic locking)
 * - Only allows specific status transitions
 */

import type { Route } from './+types/api.agents.$id.status'
import type { AgentStatus } from '~/models/agent.server'
import { Timestamp } from '@google-cloud/firestore'
import { getAgent, updateAgentStatus } from '~/models/agent.server'
import { getInstanceStatus, stopInstanceAsync } from '~/services/compute.server'
import { getFirestore } from '~/services/firestore.server'
import {
  extractAgentId,
  extractBearerToken,
  verifyGceIdentityToken,
} from '~/services/gce-identity.server'

/**
 * Helper to create JSON responses.
 */
function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init)
}

/**
 * Status update request body.
 *
 * Security: internalIp is NOT accepted from VM - it must be fetched
 * server-side to prevent SSRF attacks where a malicious VM could
 * point the proxy at arbitrary internal IPs.
 */
interface StatusUpdateRequest {
  status?: AgentStatus
  terminalReady?: boolean
  cloneStatus?: 'pending' | 'cloning' | 'completed' | 'failed'
  cloneError?: string
  errorMessage?: string
  // NOTE: internalIp intentionally NOT accepted from VM for security
}

export async function action({ request, params }: Route.ActionArgs) {
  // Only allow POST requests
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 })
  }

  // Extract and verify the GCE identity token
  const authHeader = request.headers.get('Authorization')
  const token = extractBearerToken(authHeader)

  if (!token) {
    console.warn('Status API: Missing authorization token')
    return json({ error: 'Missing authorization token' }, { status: 401 })
  }

  const verification = await verifyGceIdentityToken(token)

  if (!verification.valid || !verification.claims) {
    console.warn('Status API: Invalid token:', verification.error)
    return json({ error: verification.error || 'Invalid token' }, { status: 401 })
  }

  // Extract agent ID from params
  const agentId = extractAgentId(params, verification.claims)

  if (!agentId) {
    console.warn('Status API: Missing agent ID')
    return json({ error: 'Missing agent ID' }, { status: 400 })
  }

  // Parse request body
  let body: StatusUpdateRequest
  try {
    body = await request.json() as StatusUpdateRequest
  }
  catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Fetch agent from Firestore
  const agent = await getAgent(agentId)

  if (!agent) {
    console.warn(`Status API: Agent not found: ${agentId}`)
    return json({ error: 'Agent not found' }, { status: 404 })
  }

  // eslint-disable-next-line no-console
  console.log(`Status API: Updating agent ${agentId}`, {
    currentStatus: agent.status,
    requestedStatus: body.status,
    terminalReady: body.terminalReady,
    cloneStatus: body.cloneStatus,
  })

  try {
    // Handle full status transition
    if (body.status && body.status !== agent.status) {
      // When transitioning to 'running', fetch internalIp from GCE server-side
      // This is a security measure to prevent SSRF attacks
      // Only attempt if we have both instanceName and instanceZone
      let internalIp: string | undefined
      if (body.status === 'running' && agent.instanceName && agent.instanceZone) {
        try {
          const instanceInfo = await getInstanceStatus(agent.instanceName, agent.instanceZone)
          internalIp = instanceInfo?.internalIp
          if (!internalIp) {
            console.warn(`Status API: Could not get internal IP for instance ${agent.instanceName}`)
          }
        }
        catch (error) {
          console.error(`Status API: Failed to get instance status for ${agent.instanceName}:`, error)
        }
      }

      await updateAgentStatus(agentId, agent.status, body.status, {
        errorMessage: body.errorMessage,
        terminalReady: body.terminalReady,
        cloneStatus: body.cloneStatus,
        cloneError: body.cloneError,
        internalIp, // Server-fetched from GCE, not from VM request
      })

      // When agent exits (stopped/failed), stop the VM asynchronously
      // This prevents orphaned VMs from running forever
      if ((body.status === 'stopped' || body.status === 'failed') && agent.instanceName && agent.instanceZone) {
        // Fire-and-forget: don't wait for VM to stop
        stopInstanceAsync(agent.instanceName, agent.instanceZone)
          .catch(err => console.error(`Failed to stop VM for agent ${agentId}:`, err))
      }
    }
    else {
      // Handle partial updates (e.g., terminalReady, cloneStatus) without status change
      const db = getFirestore()
      const updates: Record<string, unknown> = {
        updatedAt: Timestamp.now(),
      }

      if (body.terminalReady !== undefined) {
        updates.terminalReady = body.terminalReady
      }

      if (body.cloneStatus !== undefined) {
        updates.cloneStatus = body.cloneStatus
        if (body.cloneError) {
          updates.cloneError = body.cloneError
        }
      }

      // NOTE: internalIp NOT accepted from VM for security - prevents SSRF

      if (body.errorMessage !== undefined) {
        updates.errorMessage = body.errorMessage
      }

      if (Object.keys(updates).length > 1) { // More than just updatedAt
        await db.collection('agents').doc(agentId).update(updates)
      }
    }

    return json({ success: true })
  }
  catch (error) {
    const statusError = error as Error & { status?: number }
    const errorStatus = statusError.status || 500

    console.error(`Status API: Update failed for agent ${agentId}:`, error)

    return json(
      { error: statusError.message || 'Failed to update status' },
      { status: errorStatus },
    )
  }
}

// GET returns current status
export async function loader({ request, params }: Route.LoaderArgs) {
  // Extract and verify the GCE identity token
  const authHeader = request.headers.get('Authorization')
  const token = extractBearerToken(authHeader)

  if (!token) {
    return json({ error: 'Missing authorization token' }, { status: 401 })
  }

  const verification = await verifyGceIdentityToken(token)

  if (!verification.valid || !verification.claims) {
    return json({ error: verification.error || 'Invalid token' }, { status: 401 })
  }

  // Validate that this VM instance is authorized for this agent
  // (same binding check as POST endpoint)
  const agentId = extractAgentId(params, verification.claims)
  if (!agentId) {
    console.warn('Status API GET: VM not authorized for agent')
    return json({ error: 'VM not authorized for this agent' }, { status: 403 })
  }

  const agent = await getAgent(agentId)
  if (!agent) {
    return json({ error: 'Agent not found' }, { status: 404 })
  }

  return json({
    status: agent.status,
    terminalReady: agent.terminalReady,
    cloneStatus: agent.cloneStatus,
    needsResume: agent.needsResume,
  })
}

// No UI for API routes
export default function StatusApi() {
  return null
}
