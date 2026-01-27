/**
 * Agent data model and Firestore operations.
 *
 * Agents represent running Claude Code instances working on GitHub issues.
 * The model implements a state machine with enforced transitions and
 * optimistic locking via statusVersion.
 */

import { Timestamp } from '@google-cloud/firestore'
import { getFirestore } from '~/services/firestore.server'

/**
 * Agent status values.
 *
 * Note: There is no 'cancelled' or 'deleted' status. Deletion is a user-initiated
 * action that removes the agent document from Firestore entirely (after deleting
 * the VM). The reaper never deletes VMs - it only suspends/stops.
 *
 * Note: 'completed' status was removed. When Claude Code exits normally (exit code 0),
 * the agent is marked as 'stopped' instead. Non-zero exit codes result in 'failed'.
 */
export type AgentStatus
  = | 'pending'
    | 'provisioning'
    | 'running'
    | 'suspended'
    | 'stopped'
    | 'failed'

/**
 * Valid status transitions.
 * Terminal state (failed) has no outgoing transitions.
 * 'stopped' can transition back to 'running' when the VM is started.
 * Deletion is handled separately (not a status transition).
 */
const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  pending: ['provisioning', 'failed'], // Can fail during initial VM creation
  provisioning: ['running', 'failed'],
  running: ['suspended', 'stopped', 'failed'],
  suspended: ['running', 'stopped'], // running = resume
  stopped: ['running'], // running = start
  failed: [],
}

/**
 * Agent document structure in Firestore.
 */
export interface Agent {
  id: string // UUID
  userId: string // Internal user UUID
  ownerGithubLogin: string // Denormalized for display (avoid N+1 lookups)
  title: string // User-provided or auto-generated title
  status: AgentStatus
  statusVersion: number // Incremented on each status change (optimistic locking)

  // Sharing
  sharedWith?: string[] // Array of internal user UUIDs

  // Target configuration
  repoOwner: string // GitHub org/user
  repoName: string // Repository name
  branch: string // Target branch
  issueNumber?: number // GitHub issue number (optional)
  issueTitle?: string // Cached issue title for display

  // Agent configuration
  instructions?: string // Optional user instructions

  // Execution metadata
  startedAt?: Timestamp
  suspendedAt?: Timestamp // When VM was suspended
  stoppedAt?: Timestamp // When VM was stopped
  errorMessage?: string

  // Compute Engine instance
  instanceName?: string // GCE instance name
  instanceZone?: string // GCE zone
  instanceStatus?: string // GCE instance status

  // Part 3: New fields for async provisioning and terminal
  // NOTE: internalIp is NOT stored in Firestore - fetched on-demand from GCE
  // to prevent exposure via Firestore subscriptions
  terminalPort?: number // WebSocket port (default 8080)
  terminalReady?: boolean // True when PTY server is ready

  // Git operation tracking
  cloneStatus?: 'pending' | 'cloning' | 'completed' | 'failed'
  cloneError?: string

  // Resume tracking
  needsResume?: boolean // True if stopped (not suspended), needs --resume flag

  // Server-side heartbeat for reaper
  lastHeartbeatAt?: Timestamp // Server-updated from WebSocket layer

  // Timestamps
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * Input for creating a new agent.
 */
export interface CreateAgentInput {
  userId: string
  ownerGithubLogin: string // Denormalized for display
  title?: string
  repoOwner: string
  repoName: string
  branch: string
  issueNumber?: number
  issueTitle?: string
  instructions?: string
}

/**
 * Options for listing agents.
 */
export interface ListAgentsOptions {
  cursor?: string // Document ID for cursor-based pagination
  limit?: number // Default 10
  statusFilter?: AgentStatus
}

/**
 * Result of listing agents with pagination.
 */
export interface ListAgentsResult {
  agents: Agent[]
  nextCursor?: string
}

/**
 * Metadata to update when changing agent status.
 * NOTE: internalIp is NOT included to prevent client exposure via Firestore subscriptions.
 * The proxy fetches internalIp from GCE on-demand when needed.
 */
export interface StatusUpdateMetadata {
  errorMessage?: string
  instanceName?: string
  instanceZone?: string
  instanceStatus?: string
  // REMOVED: internalIp - fetched on-demand from GCE to prevent client exposure
  terminalReady?: boolean
  cloneStatus?: 'pending' | 'cloning' | 'completed' | 'failed'
  cloneError?: string
  needsResume?: boolean
}

const AGENTS_COLLECTION = 'agents'

/**
 * Generates an auto-title for an agent.
 */
function generateTitle(repoOwner: string, repoName: string, issueNumber?: number): string {
  const base = `${repoOwner}/${repoName}`
  if (issueNumber) {
    return `${base}#${issueNumber}`
  }
  return base
}

/**
 * Creates a new agent in Firestore.
 *
 * @param input - Agent creation input
 * @returns The created agent
 */
export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const db = getFirestore()
  const agentId = crypto.randomUUID()
  const now = Timestamp.now()

  const agent: Agent = {
    id: agentId,
    userId: input.userId,
    ownerGithubLogin: input.ownerGithubLogin,
    title: input.title || generateTitle(input.repoOwner, input.repoName, input.issueNumber),
    status: 'pending' as const,
    statusVersion: 1,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    branch: input.branch,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    instructions: input.instructions,
    createdAt: now,
    updatedAt: now,
  }

  await db.collection(AGENTS_COLLECTION).doc(agentId).set(agent)
  return agent
}

/**
 * Gets an agent by ID.
 *
 * @param agentId - Agent UUID
 * @returns Agent or null if not found
 */
export async function getAgent(agentId: string): Promise<Agent | null> {
  const db = getFirestore()
  const doc = await db.collection(AGENTS_COLLECTION).doc(agentId).get()

  if (!doc.exists) {
    return null
  }

  return doc.data() as Agent
}

/**
 * Gets an agent by ID with ownership verification.
 * Throws 403 if userId doesn't match.
 *
 * @param agentId - Agent UUID
 * @param userId - User UUID to verify ownership
 * @returns Agent
 * @throws Error if not found or unauthorized
 */
export async function getAgentForUser(agentId: string, userId: string): Promise<Agent> {
  const agent = await getAgent(agentId)

  if (!agent) {
    const error = new Error('Agent not found')
    ;(error as Error & { status: number }).status = 404
    throw error
  }

  if (agent.userId !== userId) {
    const error = new Error('Unauthorized: Cannot access agent belonging to another user')
    ;(error as Error & { status: number }).status = 403
    throw error
  }

  return agent
}

/**
 * Lists agents for a user with cursor-based pagination.
 *
 * @param userId - User UUID
 * @param options - Pagination and filtering options
 * @returns Agents and next cursor
 */
export async function listUserAgents(
  userId: string,
  options: ListAgentsOptions = {},
): Promise<ListAgentsResult> {
  const db = getFirestore()
  const { limit = 10, cursor, statusFilter } = options

  let query = db
    .collection(AGENTS_COLLECTION)
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1) // Fetch one extra to determine if there's more

  if (statusFilter) {
    query = db
      .collection(AGENTS_COLLECTION)
      .where('userId', '==', userId)
      .where('status', '==', statusFilter)
      .orderBy('createdAt', 'desc')
      .limit(limit + 1)
  }

  if (cursor) {
    const cursorDoc = await db.collection(AGENTS_COLLECTION).doc(cursor).get()
    if (cursorDoc.exists) {
      query = query.startAfter(cursorDoc)
    }
  }

  const snapshot = await query.get()
  const agents = snapshot.docs.slice(0, limit).map(doc => doc.data() as Agent)
  const hasMore = snapshot.docs.length > limit

  return {
    agents,
    nextCursor: hasMore ? agents[agents.length - 1]?.id : undefined,
  }
}

/**
 * Updates agent status with optimistic locking.
 *
 * Uses Firestore transaction to ensure:
 * 1. Current status matches expected fromStatus
 * 2. Transition is valid according to state machine
 * 3. statusVersion is incremented
 *
 * @param agentId - Agent UUID
 * @param fromStatus - Expected current status
 * @param toStatus - Target status
 * @param metadata - Optional metadata to update
 * @returns Updated agent
 * @throws Error if status doesn't match (409) or transition is invalid
 */
export async function updateAgentStatus(
  agentId: string,
  fromStatus: AgentStatus,
  toStatus: AgentStatus,
  metadata?: StatusUpdateMetadata,
): Promise<Agent> {
  const db = getFirestore()
  const agentRef = db.collection(AGENTS_COLLECTION).doc(agentId)

  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(agentRef)

    if (!doc.exists) {
      const error = new Error('Agent not found')
      ;(error as Error & { status: number }).status = 404
      throw error
    }

    const agent = doc.data() as Agent

    // Verify current status matches expected
    if (agent.status !== fromStatus) {
      const error = new Error(
        `Status conflict: expected ${fromStatus}, got ${agent.status}`,
      )
      ;(error as Error & { status: number }).status = 409
      throw error
    }

    // Verify transition is valid
    const validTargets = VALID_TRANSITIONS[fromStatus]
    if (!validTargets.includes(toStatus)) {
      const error = new Error(
        `Invalid status transition: ${fromStatus} -> ${toStatus}`,
      )
      ;(error as Error & { status: number }).status = 400
      throw error
    }

    const now = Timestamp.now()

    const updates: Partial<Agent> = {
      status: toStatus,
      statusVersion: agent.statusVersion + 1,
      updatedAt: now,
      ...metadata,
    }

    // Set timestamp based on target status
    switch (toStatus) {
      case 'running':
        if (fromStatus === 'provisioning') {
          updates.startedAt = now
        }
        // Initialize lastHeartbeatAt for the reaper to track activity
        updates.lastHeartbeatAt = now
        break
      case 'suspended':
        updates.suspendedAt = now
        break
      case 'stopped':
        updates.stoppedAt = now
        break
    }

    transaction.update(agentRef, updates)

    return { ...agent, ...updates } as Agent
  })
}

/**
 * Updates agent's GCE instance information.
 *
 * @param agentId - Agent UUID
 * @param instanceInfo - Instance information
 * @param instanceInfo.instanceName - GCE instance name
 * @param instanceInfo.instanceZone - GCE zone
 * @param instanceInfo.instanceStatus - GCE instance status
 */
export async function updateAgentInstance(
  agentId: string,
  instanceInfo: {
    instanceName?: string
    instanceZone?: string
    instanceStatus?: string
  },
): Promise<void> {
  const db = getFirestore()
  await db.collection(AGENTS_COLLECTION).doc(agentId).update({
    ...instanceInfo,
    updatedAt: Timestamp.now(),
  })
}

/**
 * Checks if a status is terminal (no outgoing transitions).
 */
export function isTerminalStatus(status: AgentStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0
}

/**
 * Checks if a status indicates the agent is active (requires polling).
 */
export function isActiveStatus(status: AgentStatus): boolean {
  return ['pending', 'provisioning', 'running'].includes(status)
}

/**
 * Gets valid next statuses for a given status.
 * Handles legacy 'cancelled' status gracefully (returns empty array).
 */
export function getValidTransitions(status: AgentStatus | string): AgentStatus[] {
  // Handle legacy 'cancelled' status from old data
  if (!(status in VALID_TRANSITIONS)) {
    return []
  }
  return VALID_TRANSITIONS[status as AgentStatus]
}

/**
 * Safely marks an agent as failed, respecting the state machine.
 *
 * This function uses a transaction to:
 * 1. Check the current status
 * 2. Only update to 'failed' if it's a valid transition
 * 3. Skip if already in a terminal state (completed, failed)
 *
 * Used when external events (VM deletion, connection errors) indicate failure.
 *
 * @param agentId - Agent UUID
 * @param errorMessage - Error message to record
 * @returns True if status was updated, false if skipped
 */
export async function markAgentFailed(
  agentId: string,
  errorMessage: string,
): Promise<boolean> {
  const db = getFirestore()
  const agentRef = db.collection(AGENTS_COLLECTION).doc(agentId)

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(agentRef)

    if (!doc.exists) {
      return false
    }

    const agent = doc.data() as Agent

    // Check if 'failed' is a valid transition from current status
    const validTargets = VALID_TRANSITIONS[agent.status]
    if (!validTargets || !validTargets.includes('failed')) {
      // Already in terminal state or invalid transition
      return false
    }

    const now = Timestamp.now()
    tx.update(agentRef, {
      status: 'failed',
      statusVersion: agent.statusVersion + 1,
      errorMessage,
      updatedAt: now,
    })

    return true
  })
}

/**
 * Deletes an agent from Firestore.
 *
 * Note: This only deletes the Firestore document.
 * The caller is responsible for cleaning up associated resources (VM, etc).
 *
 * @param agentId - Agent UUID
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const db = getFirestore()
  await db.collection(AGENTS_COLLECTION).doc(agentId).delete()
}

// =============================================================================
// Sharing Functions
// =============================================================================

const MAX_SHARES = 50 // Prevent document bloat

/**
 * Checks if a user can access an agent (owner or shared with).
 *
 * @param agentId - Agent UUID
 * @param userId - User UUID to check
 * @returns True if user can access the agent
 */
export async function canAccessAgent(agentId: string, userId: string): Promise<boolean> {
  const agent = await getAgent(agentId)
  if (!agent) {
    return false
  }
  return agent.userId === userId || (agent.sharedWith?.includes(userId) ?? false)
}

/**
 * Checks if a user is the owner of an agent.
 *
 * @param agent - Agent object
 * @param userId - User UUID to check
 * @returns True if user is the owner
 */
export function isAgentOwner(agent: Agent, userId: string): boolean {
  return agent.userId === userId
}

/**
 * Gets an agent with access verification.
 * Unlike getAgentForUser (owner only), this allows shared users too.
 *
 * @param agentId - Agent UUID
 * @param userId - User UUID to verify access
 * @returns Agent
 * @throws Error if not found or unauthorized
 */
export async function getAgentWithAccess(agentId: string, userId: string): Promise<Agent> {
  const agent = await getAgent(agentId)

  if (!agent) {
    const error = new Error('Agent not found')
    ;(error as Error & { status: number }).status = 404
    throw error
  }

  if (!isAgentOwner(agent, userId) && !agent.sharedWith?.includes(userId)) {
    const error = new Error('Unauthorized: Cannot access agent')
    ;(error as Error & { status: number }).status = 403
    throw error
  }

  return agent
}

/**
 * Shares an agent with another user by their GitHub login.
 *
 * @param agentId - Agent UUID
 * @param ownerUserId - Owner's user UUID (for verification)
 * @param shareWithGithubLogin - GitHub login of user to share with
 * @throws Error if validation fails
 */
export async function shareAgent(
  agentId: string,
  ownerUserId: string,
  shareWithGithubLogin: string,
): Promise<void> {
  // Import here to avoid circular dependency
  const { getUserByGitHubLogin } = await import('~/models/user.server')
  const { FieldValue } = await import('@google-cloud/firestore')

  const db = getFirestore()

  await db.runTransaction(async (tx) => {
    const agentRef = db.collection(AGENTS_COLLECTION).doc(agentId)
    const agentDoc = await tx.get(agentRef)

    if (!agentDoc.exists) {
      throw new Error('Agent not found')
    }

    const agent = agentDoc.data() as Agent

    // Validate owner
    if (agent.userId !== ownerUserId) {
      throw new Error('Only the owner can share this agent')
    }

    // Look up user by GitHub login
    const userToShare = await getUserByGitHubLogin(shareWithGithubLogin)
    if (!userToShare) {
      throw new Error('User not found. They must log in at least once.')
    }

    // Prevent sharing with self
    if (userToShare.id === ownerUserId) {
      throw new Error('Cannot share with yourself')
    }

    // Check max shares
    const currentShares = agent.sharedWith?.length ?? 0
    if (currentShares >= MAX_SHARES) {
      throw new Error(`Maximum ${MAX_SHARES} shares reached`)
    }

    // Check if already shared
    if (agent.sharedWith?.includes(userToShare.id)) {
      throw new Error('Already shared with this user')
    }

    // Update array
    tx.update(agentRef, {
      sharedWith: FieldValue.arrayUnion(userToShare.id),
      updatedAt: Timestamp.now(),
    })
  })
}

/**
 * Removes sharing access from a user.
 *
 * @param agentId - Agent UUID
 * @param ownerUserId - Owner's user UUID (for verification)
 * @param unshareUserId - User UUID to remove
 * @throws Error if validation fails
 */
export async function unshareAgent(
  agentId: string,
  ownerUserId: string,
  unshareUserId: string,
): Promise<void> {
  const { FieldValue } = await import('@google-cloud/firestore')
  const db = getFirestore()

  await db.runTransaction(async (tx) => {
    const agentRef = db.collection(AGENTS_COLLECTION).doc(agentId)
    const agentDoc = await tx.get(agentRef)

    if (!agentDoc.exists) {
      throw new Error('Agent not found')
    }

    const agent = agentDoc.data() as Agent

    if (agent.userId !== ownerUserId) {
      throw new Error('Only the owner can unshare')
    }

    tx.update(agentRef, {
      sharedWith: FieldValue.arrayRemove(unshareUserId),
      updatedAt: Timestamp.now(),
    })
  })
}

/**
 * Lists all agents a user can access (owned + shared).
 * Sorted by updatedAt descending.
 *
 * @param userId - User UUID
 * @returns List of agents
 */
export async function listAccessibleAgents(userId: string): Promise<Agent[]> {
  const db = getFirestore()

  // Query both owned and shared agents
  const [ownedSnap, sharedSnap] = await Promise.all([
    db.collection(AGENTS_COLLECTION)
      .where('userId', '==', userId)
      .get(),
    db.collection(AGENTS_COLLECTION)
      .where('sharedWith', 'array-contains', userId)
      .get(),
  ])

  const agents = [
    ...ownedSnap.docs.map(d => ({ ...d.data() as Agent, id: d.id })),
    ...sharedSnap.docs.map(d => ({ ...d.data() as Agent, id: d.id })),
  ]

  // Sort by updatedAt descending
  return agents.sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis())
}

/**
 * Gets users who have access to an agent.
 * Returns list of user IDs that the agent is shared with.
 *
 * @param agentId - Agent UUID
 * @returns Array of user UUIDs
 */
export async function getAgentSharedWith(agentId: string): Promise<string[]> {
  const agent = await getAgent(agentId)
  return agent?.sharedWith ?? []
}
