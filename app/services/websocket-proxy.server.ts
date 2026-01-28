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
import { getInstanceInfo } from '~/services/compute.server'
import { getFirestore } from '~/services/firestore.server'
import { env } from './env.server'
import { getSecret } from './secrets.server'

// VM terminal port
const VM_TERMINAL_PORT = 8080

// Heartbeat throttling - max once per 60 seconds
const HEARTBEAT_THROTTLE_MS = 60_000

// Ping/pong constants for VM connection health monitoring
const PING_INTERVAL_MS = 30_000 // 30 seconds
const PONG_TIMEOUT_MS = 65_000 // 65 seconds (just over 2x ping interval)
const VM_HANDSHAKE_TIMEOUT_MS = 10_000 // 10 seconds for initial VM connection

// VM reconnection constants
const MAX_VM_RETRY_ATTEMPTS = 5
const VM_RETRY_BASE_DELAY_MS = 1000

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
export type WsMessageType
  = | 'resize' // Client -> VM
    | 'takeover' // Client -> VM
    | 'connected' // VM -> Client
    | 'session_active' // VM -> Client
    | 'session_taken_over' // VM -> Client
    | 'vm_reconnecting' // Proxy -> Client (new)
    | 'error' // VM/Proxy -> Client
    | 'exit' // VM -> Client

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
    const timestamp = Timestamp.now()
    await db.collection('agents').doc(agentId).update({
      lastHeartbeatAt: timestamp,
      updatedAt: timestamp,
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
        const instanceInfo = await getInstanceInfo(agent.instanceName, agent.instanceZone)
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

  // Track connection state
  let vmConnected = false
  let browserConnected = true
  let vmRetryAttempt = 0
  let vmPingInterval: NodeJS.Timeout | null = null
  let currentVmWs: WsClient | null = null

  /**
   * Sets up connection to VM with all event handlers.
   * Can be called for initial connection or retries.
   * Uses the vmIp fetched at connection start (assumes IP doesn't change).
   */
  function connectToVm(): Promise<boolean> {
    return new Promise((resolve) => {
      const vmUrl = `ws://${vmIp}:${VM_TERMINAL_PORT}`
      const vmWs = new WsClient(vmUrl, {
        handshakeTimeout: VM_HANDSHAKE_TIMEOUT_MS,
      })

      currentVmWs = vmWs

      // Timestamp-based heartbeat tracking for VM connection
      let vmLastPongAt = Date.now()

      vmWs.on('open', () => {
        vmConnected = true
        vmRetryAttempt = 0 // Reset retry counter on successful connection
        // eslint-disable-next-line no-console
        console.log('WebSocket proxy: Connected to VM for agent:', agentId)

        // Initialize heartbeat on connection
        updateHeartbeat(agentId)

        // Set up VM ping/pong health check
        if (vmPingInterval) {
          clearInterval(vmPingInterval)
        }
        vmPingInterval = setInterval(() => {
          if (!vmConnected || vmWs.readyState !== vmWs.OPEN) {
            if (vmPingInterval) {
              clearInterval(vmPingInterval)
              vmPingInterval = null
            }
            return
          }

          // Check if VM pong timed out
          if (Date.now() - vmLastPongAt > PONG_TIMEOUT_MS) {
            console.error(`WebSocket proxy: VM pong timeout for agent ${agentId}`)
            if (vmPingInterval) {
              clearInterval(vmPingInterval)
              vmPingInterval = null
            }
            vmWs.close(1011, 'Pong timeout')
            // Don't close browser here - close handler will attempt retry
            return
          }

          vmWs.ping()
        }, PING_INTERVAL_MS)

        resolve(true)
      })

      vmWs.on('pong', () => {
        vmLastPongAt = Date.now()
      })

      vmWs.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (browserConnected && ws.readyState === ws.OPEN) {
          // Forward message from VM to browser, preserving binary flag
          ws.send(data, { binary: isBinary })

          // Update server-side heartbeat on any VM output (throttled)
          updateHeartbeat(agentId)
        }
      })

      vmWs.on('error', async (error) => {
        console.error('WebSocket proxy: VM connection error:', error.message)
        vmConnected = false

        // Check if VM still exists - if not, mark agent as failed
        const { instanceName, instanceZone } = agent ?? {}
        if (instanceName && instanceZone) {
          try {
            const instanceInfo = await getInstanceInfo(instanceName, instanceZone)
            if (!instanceInfo) {
              // VM was deleted externally - mark agent as failed
              console.error(`WebSocket proxy: VM ${instanceName} not found, marking agent ${agentId} as failed`)
              const updated = await markAgentFailed(agentId, 'VM was deleted externally')
              if (!updated) {
                console.warn(`WebSocket proxy: Could not mark agent ${agentId} as failed (already terminal or not found)`)
              }
              // Don't retry if VM was deleted
              if (browserConnected && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: 'VM was deleted' }))
                ws.close(1011, 'VM was deleted')
              }
              resolve(false)
            }
          }
          catch (checkError) {
            console.warn('WebSocket proxy: Failed to check VM status:', checkError)
          }
        }

        // Error will be followed by close event which handles retry and resolves
      })

      // VM close handler with retry logic
      vmWs.on('close', async (code, reason) => {
        // eslint-disable-next-line no-console
        console.log('WebSocket proxy: VM connection closed:', code, reason.toString())
        vmConnected = false

        // Clear VM ping interval
        if (vmPingInterval) {
          clearInterval(vmPingInterval)
          vmPingInterval = null
        }

        // Don't retry if browser already disconnected
        if (!browserConnected || ws.readyState !== ws.OPEN) {
          resolve(false)
          return
        }

        // Don't retry on normal close, policy violation, or session takeover
        const noRetryCodes = [1000, 1008, 4409]
        if (noRetryCodes.includes(code)) {
          ws.close(code, reason.toString())
          resolve(false)
          return
        }

        // Check retry limit
        if (vmRetryAttempt >= MAX_VM_RETRY_ATTEMPTS) {
          console.error(`WebSocket proxy: Max VM retry attempts (${MAX_VM_RETRY_ATTEMPTS}) reached for agent ${agentId}`)
          ws.send(JSON.stringify({ type: 'error', message: 'VM connection failed after multiple retries' }))
          ws.close(1011, 'VM reconnection failed')
          resolve(false)
          return
        }

        // Notify browser on first retry attempt that VM leg is reconnecting
        if (vmRetryAttempt === 0 && browserConnected && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'vm_reconnecting' }))
        }

        // Calculate exponential backoff with jitter
        const baseDelay = Math.min(VM_RETRY_BASE_DELAY_MS * 2 ** vmRetryAttempt, 30000)
        const jitter = Math.random() * 1000
        const delay = baseDelay + jitter

        vmRetryAttempt++
        // eslint-disable-next-line no-console
        console.log(`WebSocket proxy: VM closed, reconnecting in ${Math.round(delay)}ms (attempt ${vmRetryAttempt}/${MAX_VM_RETRY_ATTEMPTS}) for agent ${agentId}`)

        // Wait before retry
        await new Promise(r => setTimeout(r, delay))

        // Check browser still connected after delay
        if (!browserConnected || ws.readyState !== ws.OPEN) {
          resolve(false)
          return
        }

        // Attempt reconnection - propagate result to original promise
        const reconnected = await connectToVm()
        resolve(reconnected)
      })
    })
  }

  // Handle browser messages - forward to current VM connection
  ws.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (vmConnected && currentVmWs && currentVmWs.readyState === WsClient.OPEN) {
      // Forward message from browser to VM, preserving binary flag
      currentVmWs.send(data, { binary: isBinary })

      // Update heartbeat on user input (binary packets are stdin)
      if (isBinary) {
        updateHeartbeat(agentId)
      }
      // Non-binary messages are control messages (resize, etc.) - no heartbeat update
    }
  })

  ws.on('error', (error) => {
    console.error('WebSocket proxy: Browser connection error:', error.message)
    browserConnected = false
    if (vmConnected && currentVmWs && currentVmWs.readyState === WsClient.OPEN) {
      currentVmWs.close()
    }
  })

  // Browser close handler - cleans up all resources
  // Note: No browser ping/pong - let clients be inactive in background tabs
  ws.on('close', () => {
    // eslint-disable-next-line no-console
    console.log('WebSocket proxy: Browser connection closed for agent:', agentId)
    browserConnected = false

    // Clean up VM connection
    if (vmConnected && currentVmWs && currentVmWs.readyState === WsClient.OPEN) {
      currentVmWs.close()
    }

    // Clean up intervals
    if (vmPingInterval) {
      clearInterval(vmPingInterval)
      vmPingInterval = null
    }

    // Clean up heartbeat tracking to prevent memory leak
    lastHeartbeatUpdates.delete(agentId)
  })

  // 7. Initial VM connection
  const connected = await connectToVm()
  if (!connected) {
    // Initial connection failed - close browser connection
    if (browserConnected && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to connect to VM' }))
      ws.close(1011, 'VM connection failed')
    }
    return { success: false, error: 'Failed to connect to VM', errorCode: 4500 }
  }

  return { success: true }
}
