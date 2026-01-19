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
 */
export type AgentStatus
  = | 'pending'
    | 'provisioning'
    | 'running'
    | 'suspended'
    | 'stopped'
    | 'completed'
    | 'failed'
    | 'cancelled'

/**
 * Valid status transitions.
 * Terminal states (completed, failed, cancelled) have no outgoing transitions.
 */
const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  pending: ['provisioning'],
  provisioning: ['running', 'failed'],
  running: ['suspended', 'stopped', 'completed', 'failed', 'cancelled'],
  suspended: ['running', 'stopped', 'cancelled'], // running = resume
  stopped: ['running', 'cancelled'], // running = start
  completed: [],
  failed: [],
  cancelled: [],
}

/**
 * Agent document structure in Firestore.
 */
export interface Agent {
  id: string // UUID
  userId: string // Internal user UUID
  title: string // User-provided or auto-generated title
  status: AgentStatus
  statusVersion: number // Incremented on each status change (optimistic locking)

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
  completedAt?: Timestamp
  errorMessage?: string

  // Compute Engine instance
  instanceName?: string // GCE instance name
  instanceZone?: string // GCE zone
  instanceStatus?: string // GCE instance status

  // Timestamps
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * Input for creating a new agent.
 */
export interface CreateAgentInput {
  userId: string
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
 */
export interface StatusUpdateMetadata {
  errorMessage?: string
  instanceName?: string
  instanceZone?: string
  instanceStatus?: string
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
    title: input.title || generateTitle(input.repoOwner, input.repoName, input.issueNumber),
    status: 'pending',
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
        break
      case 'suspended':
        updates.suspendedAt = now
        break
      case 'stopped':
        updates.stoppedAt = now
        break
      case 'completed':
        updates.completedAt = now
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
 */
export function getValidTransitions(status: AgentStatus): AgentStatus[] {
  return VALID_TRANSITIONS[status]
}
