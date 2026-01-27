/**
 * Agent Heartbeat API Endpoint.
 *
 * Updates the lastHeartbeatAt timestamp for an agent.
 * Used by the WebSocket proxy to track VM activity for the reaper.
 *
 * Security:
 * - ONLY authenticates via GCE identity token (VM requests only)
 * - Browser requests are rejected to prevent cost-leak attacks
 *   (users cannot keep agents alive without real terminal activity)
 * - Uses Firestore set/merge for race safety
 */

import type { ActionFunctionArgs } from 'react-router'
import { Timestamp } from '@google-cloud/firestore'
import { getAgent } from '~/models/agent.server'
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

export async function action({ request, params }: ActionFunctionArgs) {
  // Only allow POST requests
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 })
  }

  const agentId = params.id
  if (!agentId) {
    return json({ error: 'Missing agent ID' }, { status: 400 })
  }

  // ONLY allow GCE identity token (VM requests only)
  // Browser session auth is intentionally disabled to prevent cost-leak attacks
  // where users could keep agents alive without real terminal activity
  const authHeader = request.headers.get('Authorization')
  const token = extractBearerToken(authHeader)

  if (!token) {
    return json({ error: 'Unauthorized - VM token required' }, { status: 401 })
  }

  // Verify GCE identity token
  const verification = await verifyGceIdentityToken(token)
  if (!verification.valid || !verification.claims) {
    return json({ error: 'Invalid VM token' }, { status: 401 })
  }

  // Fetch agent first (needed for instance name validation)
  const agent = await getAgent(agentId)
  if (!agent) {
    return json({ error: 'Agent not found' }, { status: 404 })
  }

  // Validate that this VM instance is authorized for this agent
  // Uses stored instanceName and instanceZone from Firestore as source of truth
  const extractedAgentId = extractAgentId(params, verification.claims, agent.instanceName, agent.instanceZone)
  if (extractedAgentId !== agentId) {
    return json({ error: 'Token does not match agent' }, { status: 403 })
  }

  // Only update heartbeat for running agents
  if (agent.status !== 'running') {
    return json({ error: 'Agent not running' }, { status: 400 })
  }

  try {
    const db = getFirestore()
    const agentRef = db.collection('agents').doc(agentId)

    // Use set with merge for race-safe update
    // This avoids read-before-write pattern that could cause races
    await agentRef.set({
      lastHeartbeatAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }, { merge: true })

    return json({ success: true })
  }
  catch (error) {
    console.error('Heartbeat update failed:', error)
    return json({ error: 'Failed to update heartbeat' }, { status: 500 })
  }
}

// No UI for API routes
export default function HeartbeatApi() {
  return null
}
