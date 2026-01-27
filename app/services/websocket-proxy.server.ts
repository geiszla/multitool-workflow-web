/**
 * WebSocket Proxy Service.
 *
 * Proxies WebSocket connections from browser to VM.
 * Handles Origin validation, session authentication, and message forwarding.
 *
 * Security:
 * - Origin validation (CSRF protection)
 * - Session cookie validation (using same session storage as HTTP routes)
 * - Agent ownership verification
 * - No client-controlled host/port (prevents SSRF)
 */

import type { Buffer } from 'node:buffer'
import type { IncomingMessage } from 'node:http'
import type WebSocket from 'ws'
import { Timestamp } from '@google-cloud/firestore'
import { createCookieSessionStorage } from 'react-router'
import { WebSocket as WsClient } from 'ws'
import { canAccessAgent, getAgent, markAgentFailed } from '~/models/agent.server'
import { getSession as getFirestoreSession } from '~/models/session.server'
import { getInstanceStatus } from '~/services/compute.server'
import { getFirestore } from '~/services/firestore.server'
import { env } from './env.server'
import { getSecret } from './secrets.server'

// VM terminal port
const VM_TERMINAL_PORT = 8080

// Heartbeat throttling - max once per 60 seconds
const HEARTBEAT_THROTTLE_MS = 60_000

// Track last heartbeat update per agent to avoid excessive Firestore writes
const lastHeartbeatUpdates = new Map<string, number>()

// Allowed origins for WebSocket connections
function getAllowedOrigins(): string[] {
  const origins = [env.APP_URL]

  // In development, also allow localhost
  if (env.NODE_ENV === 'development') {
    origins.push('http://localhost:3000')
    origins.push('http://localhost:5173')
  }

  return origins
}

/**
 * WebSocket message types (must match VM pty-server protocol).
 */
export type WsMessageType = 'stdin' | 'stdout' | 'resize' | 'ping' | 'pong' | 'error' | 'exit'

export interface WsMessage {
  type: WsMessageType
  data?: string
  cols?: number
  rows?: number
  code?: number
  message?: string
}

/**
 * Validates the Origin header for CSRF protection.
 *
 * @param origin - Origin header value
 * @returns True if origin is allowed
 */
export function validateOrigin(origin: string | undefined): boolean {
  // Reject if Origin header is missing (fail closed)
  if (!origin) {
    return false
  }

  const allowed = getAllowedOrigins()
  return allowed.includes(origin)
}

/**
 * Session storage configuration type.
 */
interface SessionData {
  sessionId: string
}

interface SessionFlashData {
  error: string
}

type AppSessionStorage = ReturnType<
  typeof createCookieSessionStorage<SessionData, SessionFlashData>
>

// Lazy-initialized session storage for WebSocket connections
let wsSessionStorageCache: AppSessionStorage | null = null
let wsSessionStorageInitialized = false

/**
 * Gets the session storage for WebSocket connections.
 * Uses the same configuration as the HTTP session storage.
 */
async function getWsSessionStorage(): Promise<AppSessionStorage | null> {
  if (wsSessionStorageInitialized) {
    return wsSessionStorageCache
  }

  try {
    const sessionSecret = await getSecret('session-secret')

    wsSessionStorageCache = createCookieSessionStorage<SessionData, SessionFlashData>({
      cookie: {
        name: '__session',
        httpOnly: true,
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: '/',
        sameSite: 'lax',
        secrets: [sessionSecret],
        secure: process.env.NODE_ENV === 'production',
      },
    })
    wsSessionStorageInitialized = true
    return wsSessionStorageCache
  }
  catch (error) {
    console.warn('WebSocket session storage initialization failed:', error)
    return null
  }
}

/**
 * Validates session and returns user ID.
 * Uses the same session validation as HTTP routes, including signature verification.
 *
 * @param request - HTTP upgrade request
 * @returns User ID or null if invalid
 */
async function validateSession(request: IncomingMessage): Promise<string | null> {
  const sessionStorage = await getWsSessionStorage()
  if (!sessionStorage) {
    return null
  }

  try {
    // Use the session storage to properly parse and verify the signed cookie
    const session = await sessionStorage.getSession(request.headers.cookie)
    const sessionId = session.get('sessionId')

    if (!sessionId) {
      return null
    }

    // Validate session exists in Firestore and is not expired
    const firestoreSession = await getFirestoreSession(sessionId)
    if (!firestoreSession) {
      return null
    }

    return firestoreSession.userId
  }
  catch (error) {
    console.warn('WebSocket session validation failed:', error)
    return null
  }
}

/**
 * Updates the lastHeartbeatAt timestamp for an agent (throttled).
 * Used by the server-side reaper to track VM activity.
 *
 * @param agentId - Agent UUID
 */
async function updateHeartbeat(agentId: string): Promise<void> {
  const now = Date.now()
  const lastUpdate = lastHeartbeatUpdates.get(agentId) ?? 0

  // Throttle heartbeat updates to max once per minute
  if (now - lastUpdate < HEARTBEAT_THROTTLE_MS) {
    return
  }

  lastHeartbeatUpdates.set(agentId, now)

  try {
    const db = getFirestore()
    await db.collection('agents').doc(agentId).update({
      lastHeartbeatAt: Timestamp.now(),
    })
  }
  catch (error) {
    console.error('Failed to update lastHeartbeatAt:', error)
  }
}

/**
 * Result of WebSocket connection setup.
 */
export interface ProxyConnectionResult {
  success: boolean
  error?: string
  errorCode?: number
}

/**
 * Sets up WebSocket proxy connection from browser to VM.
 *
 * @param ws - Browser WebSocket connection
 * @param request - HTTP upgrade request
 * @param agentId - Agent UUID from URL
 * @returns Connection result
 */
export async function setupProxyConnection(
  ws: WebSocket,
  request: IncomingMessage,
  agentId: string,
): Promise<ProxyConnectionResult> {
  // 1. Validate Origin header
  const origin = request.headers.origin
  if (!validateOrigin(origin)) {
    console.warn('WebSocket proxy: Invalid origin:', origin)
    // Use WebSocket close code 4003 (custom code for forbidden) instead of HTTP 403
    return { success: false, error: 'Invalid origin', errorCode: 4003 }
  }

  // 2. Validate session
  const userId = await validateSession(request)
  if (!userId) {
    console.warn('WebSocket proxy: Invalid session')
    // Use WebSocket close code 4001 (custom code for unauthorized) instead of HTTP 401
    return { success: false, error: 'Unauthorized', errorCode: 4001 }
  }

  // 3. Fetch agent and verify access (owner or shared)
  const agent = await getAgent(agentId)
  if (!agent) {
    console.warn('WebSocket proxy: Agent not found:', agentId)
    // Use WebSocket close code 4004 (custom code for not found) instead of HTTP 404
    return { success: false, error: 'Agent not found', errorCode: 4004 }
  }

  // Check if user can access the agent (owner or shared)
  const hasAccess = await canAccessAgent(agentId, userId)
  if (!hasAccess) {
    console.warn('WebSocket proxy: Unauthorized access to agent:', agentId)
    // Use WebSocket close code 4003 (custom code for forbidden) instead of HTTP 403
    return { success: false, error: 'Forbidden', errorCode: 4003 }
  }

  // 4. Verify agent is running
  if (agent.status !== 'running') {
    console.warn('WebSocket proxy: Agent not running:', agentId, agent.status)
    // Use WebSocket close code 4000 (custom code for bad request) instead of HTTP 400
    return { success: false, error: `Agent is ${agent.status}`, errorCode: 4000 }
  }

  // 5. Verify terminal is ready
  if (!agent.terminalReady) {
    console.warn('WebSocket proxy: Terminal not ready:', agentId)
    // Use WebSocket close code 4503 (custom code for service unavailable) instead of HTTP 503
    return { success: false, error: 'Terminal not ready', errorCode: 4503 }
  }

  // 6. Resolve VM IP (server-side only, fetched from GCE on each connection)
  // Never stores in Firestore to prevent client exposure
  let vmIp: string | undefined
  if (agent.instanceName && agent.instanceZone) {
    // Fetch from GCE with retry
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const instanceInfo = await getInstanceStatus(agent.instanceName, agent.instanceZone)
        if (instanceInfo?.internalIp) {
          vmIp = instanceInfo.internalIp
          // eslint-disable-next-line no-console
          console.log(`WebSocket proxy: Fetched internal IP from GCE for agent ${agentId}: ${vmIp}`)
          break
        }
      }
      catch (error) {
        console.warn(`WebSocket proxy: GCE fetch attempt ${attempt + 1} failed:`, error)
      }

      // Exponential backoff: 500ms, 1s, 2s
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
      }
    }
  }

  if (!vmIp) {
    console.error('WebSocket proxy: No internal IP for agent:', agentId)
    // Use WebSocket close code 4500 (custom code for server error) instead of HTTP 500
    return { success: false, error: 'VM IP not available', errorCode: 4500 }
  }

  // eslint-disable-next-line no-console
  console.log(`WebSocket proxy: Connecting to VM ${vmIp}:${VM_TERMINAL_PORT} for agent ${agentId}`)

  // 7. Connect to VM
  const vmUrl = `ws://${vmIp}:${VM_TERMINAL_PORT}`
  const vmWs = new WsClient(vmUrl)

  // Track connection state
  let vmConnected = false
  let browserConnected = true

  // Handle VM connection
  vmWs.on('open', () => {
    vmConnected = true
    // eslint-disable-next-line no-console
    console.log('WebSocket proxy: Connected to VM for agent:', agentId)

    // Initialize heartbeat on connection
    updateHeartbeat(agentId)
  })

  vmWs.on('message', (data: Buffer | string) => {
    if (browserConnected && ws.readyState === ws.OPEN) {
      // Forward message from VM to browser
      ws.send(data.toString())

      // Update server-side heartbeat on any VM output (throttled)
      updateHeartbeat(agentId)
    }
  })

  vmWs.on('close', (code, reason) => {
    // eslint-disable-next-line no-console
    console.log('WebSocket proxy: VM connection closed:', code, reason.toString())
    vmConnected = false
    if (browserConnected && ws.readyState === ws.OPEN) {
      ws.close(code, reason.toString())
    }
  })

  vmWs.on('error', async (error) => {
    console.error('WebSocket proxy: VM connection error:', error.message)
    vmConnected = false

    // Check if VM still exists - if not, mark agent as failed
    // Only check if we have both instanceName and instanceZone
    if (agent.instanceName && agent.instanceZone) {
      try {
        const instanceInfo = await getInstanceStatus(agent.instanceName, agent.instanceZone)
        if (!instanceInfo) {
          // VM was deleted externally - mark agent as failed using state machine
          console.error(`WebSocket proxy: VM ${agent.instanceName} not found, marking agent ${agentId} as failed`)
          const updated = await markAgentFailed(agentId, 'VM was deleted externally')
          if (!updated) {
            console.warn(`WebSocket proxy: Could not mark agent ${agentId} as failed (already terminal or not found)`)
          }
        }
      }
      catch (checkError) {
        console.warn('WebSocket proxy: Failed to check VM status:', checkError)
      }
    }

    if (browserConnected && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'VM connection error' }))
      ws.close(1011, 'VM connection error')
    }
  })

  // Handle browser messages
  ws.on('message', (data: Buffer | string) => {
    if (vmConnected && vmWs.readyState === vmWs.OPEN) {
      // Forward message from browser to VM
      vmWs.send(data.toString())

      // Update heartbeat on user input (stdin only, not resize or other messages)
      try {
        const msg = JSON.parse(data.toString()) as WsMessage
        if (msg.type === 'stdin') {
          updateHeartbeat(agentId)
        }
      }
      catch {
        // Ignore parse errors
      }
    }
  })

  ws.on('close', () => {
    // eslint-disable-next-line no-console
    console.log('WebSocket proxy: Browser connection closed for agent:', agentId)
    browserConnected = false
    if (vmConnected && vmWs.readyState === vmWs.OPEN) {
      vmWs.close()
    }
  })

  ws.on('error', (error) => {
    console.error('WebSocket proxy: Browser connection error:', error.message)
    browserConnected = false
    if (vmConnected && vmWs.readyState === vmWs.OPEN) {
      vmWs.close()
    }
  })

  // Ping/pong health check (every 30 seconds)
  const pingInterval = setInterval(() => {
    if (browserConnected && ws.readyState === ws.OPEN) {
      ws.ping()
    }
    else {
      clearInterval(pingInterval)
    }
  }, 30000)

  ws.on('pong', () => {
    // Browser is alive
  })

  return { success: true }
}
