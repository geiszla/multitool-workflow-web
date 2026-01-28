/**
 * VM Reaper Service.
 *
 * Automatically suspends and stops inactive VMs to save costs.
 * Called periodically by Cloud Scheduler.
 *
 * Two-stage timeout:
 * 1. Running -> Suspended after 15 minutes of inactivity
 * 2. Suspended -> Stopped after 1 hour of inactivity
 *
 * IMPORTANT: The reaper only suspends/stops VMs, it never deletes them.
 * Deletion is a user-initiated action via the UI.
 *
 * Required Firestore composite index:
 *   Collection: agents
 *   Fields: status ASC, lastHeartbeatAt ASC
 *
 * Deploy indexes: firebase deploy --only firestore:indexes
 * Or create manually in Firebase Console.
 */

import type { Agent } from '~/models/agent.server'
import { Timestamp } from '@google-cloud/firestore'
import { OAuth2Client } from 'google-auth-library'
import { getAgent, updateAgentStatus } from '~/models/agent.server'
import { stopInstance, suspendInstance } from '~/services/compute.server'
import { getFirestore } from '~/services/firestore.server'

// Timeouts
const SUSPEND_AFTER_MS = 15 * 60 * 1000 // 15 minutes
const STOP_AFTER_MS = 60 * 60 * 1000 // 1 hour
const GRACE_PERIOD_MS = 2 * 60 * 1000 // 2 min grace after resume

// Query limits
const PAGE_SIZE = 200
const MAX_CONCURRENCY = 5
const LOCK_TTL_MS = 5 * 60 * 1000 // 5 minute lease

// Expected OIDC issuers
const EXPECTED_ISS = new Set(['https://accounts.google.com', 'accounts.google.com'])

// OAuth client for token verification
const oauthClient = new OAuth2Client()

/**
 * Reaper execution result.
 */
export interface ReaperResult {
  skipped?: boolean
  reason?: string
  suspended?: Array<{ action: string, agentId: string } | { skipped: boolean }>
  stopped?: Array<{ action: string, agentId: string } | { skipped: boolean }>
}

/**
 * Verifies the Cloud Scheduler OIDC token.
 *
 * @param authHeader - Authorization header value
 * @returns True if token is valid
 */
export async function verifySchedulerToken(authHeader: string | null): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) {
    return false
  }

  const idToken = authHeader.slice(7)
  const reaperAudience = process.env.REAPER_AUDIENCE
  const schedulerEmail = process.env.SCHEDULER_SERVICE_ACCOUNT_EMAIL

  if (!reaperAudience || !schedulerEmail) {
    console.error('Reaper: Missing REAPER_AUDIENCE or SCHEDULER_SERVICE_ACCOUNT_EMAIL env vars')
    return false
  }

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: reaperAudience,
    })

    const payload = ticket.getPayload()
    if (!payload) {
      return false
    }

    if (!EXPECTED_ISS.has(payload.iss ?? '')) {
      console.warn('Reaper: Unexpected issuer:', payload.iss)
      return false
    }

    if (!payload.email_verified) {
      console.warn('Reaper: Email not verified')
      return false
    }

    if (payload.email !== schedulerEmail) {
      console.warn('Reaper: Unexpected service account:', payload.email)
      return false
    }

    return true
  }
  catch (error) {
    console.error('Reaper: Token verification failed:', error instanceof Error ? error.message : 'Unknown error')
    return false
  }
}

/**
 * Acquires a distributed lock for the reaper.
 *
 * @param lockRef - Firestore document reference for the lock
 * @param ttlMs - Lock TTL in milliseconds
 * @returns True if lock was acquired
 */
async function acquireLock(lockRef: FirebaseFirestore.DocumentReference, ttlMs: number): Promise<boolean> {
  const db = getFirestore()
  const now = Timestamp.now()

  try {
    await db.runTransaction(async (tx) => {
      const lockDoc = await tx.get(lockRef)

      if (lockDoc.exists) {
        const data = lockDoc.data()
        const expiresAt = data?.expiresAt as Timestamp | undefined
        if (expiresAt && expiresAt.toMillis() > now.toMillis()) {
          // Lock is held by another process
          throw new Error('Lock held')
        }
      }

      // Acquire or renew lock
      tx.set(lockRef, {
        acquiredAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + ttlMs),
      })
    })

    return true
  }
  catch (error) {
    if (error instanceof Error && error.message === 'Lock held') {
      return false
    }
    throw error
  }
}

/**
 * Releases the reaper lock.
 *
 * @param lockRef - Firestore document reference for the lock
 */
async function releaseLock(lockRef: FirebaseFirestore.DocumentReference): Promise<void> {
  try {
    await lockRef.delete()
  }
  catch (error) {
    console.error('Reaper: Failed to release lock:', error instanceof Error ? error.message : 'Unknown error')
  }
}

/**
 * Processes items with bounded concurrency.
 *
 * @param items - Items to process
 * @param concurrency - Max concurrent operations
 * @param processor - Function to process each item
 * @returns Results of all operations
 */
async function processInBatches<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(processor))
    results.push(...batchResults)
  }

  return results
}

/**
 * Queries agents with pagination support.
 * Fetches all matching agents across multiple pages.
 *
 * @param db - Firestore instance
 * @param status - Agent status to query
 * @param cutoff - Timestamp cutoff for lastHeartbeatAt
 * @returns Array of matching agents
 */
async function queryAgentsWithPagination(
  db: FirebaseFirestore.Firestore,
  status: string,
  cutoff: Timestamp,
): Promise<Array<Agent & { id: string }>> {
  const agents: Array<Agent & { id: string }> = []
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null

  // Paginate through all matching documents
  while (true) {
    let query = db.collection('agents')
      .where('status', '==', status)
      .where('lastHeartbeatAt', '<', cutoff)
      .orderBy('lastHeartbeatAt', 'asc')
      .limit(PAGE_SIZE)

    if (lastDoc) {
      query = query.startAfter(lastDoc)
    }

    const snapshot = await query.get()

    if (snapshot.empty) {
      break
    }

    for (const doc of snapshot.docs) {
      agents.push(doc.data() as Agent)
    }

    // If we got fewer than PAGE_SIZE, we're done
    if (snapshot.docs.length < PAGE_SIZE) {
      break
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1]
  }

  return agents
}

/**
 * Runs the VM reaper.
 *
 * Queries for inactive agents and suspends/stops their VMs.
 * Uses a distributed lock to prevent concurrent runs.
 * Supports pagination to handle more than PAGE_SIZE agents.
 *
 * @returns Reaper result
 */
export async function runReaper(): Promise<ReaperResult> {
  const db = getFirestore()
  const lockRef = db.collection('locks').doc('reaper')

  // Acquire lease lock to prevent concurrent runs
  const lockAcquired = await acquireLock(lockRef, LOCK_TTL_MS)
  if (!lockAcquired) {
    return { skipped: true, reason: 'Another reaper is running' }
  }

  try {
    const now = Timestamp.now()
    const suspendCutoff = Timestamp.fromMillis(now.toMillis() - SUSPEND_AFTER_MS)
    const stopCutoff = Timestamp.fromMillis(now.toMillis() - STOP_AFTER_MS)
    const graceCutoff = Timestamp.fromMillis(now.toMillis() - GRACE_PERIOD_MS)

    // Query running agents past suspend threshold with pagination
    // Note: Requires composite index on (status, lastHeartbeatAt)
    const runningAgents = await queryAgentsWithPagination(db, 'running', suspendCutoff)

    // Query suspended agents past stop threshold with pagination
    // Note: Requires composite index on (status, lastHeartbeatAt)
    const suspendedAgents = await queryAgentsWithPagination(db, 'suspended', stopCutoff)

    const toSuspend = runningAgents
      // Exclude recently started agents (grace period)
      .filter((agent) => {
        const startedAt = agent.startedAt?.toMillis() ?? 0
        return startedAt < graceCutoff.toMillis()
      })

    const toStop = suspendedAgents

    // eslint-disable-next-line no-console
    console.log(`Reaper: Found ${toSuspend.length} agents to suspend, ${toStop.length} agents to stop`)

    // Process with bounded concurrency
    const [suspendResults, stopResults] = await Promise.all([
      processInBatches(toSuspend, MAX_CONCURRENCY, async (agent) => {
        try {
          // Re-check freshness before acting (idempotency)
          const fresh = await getAgent(agent.id)
          if (!fresh || fresh.status !== 'running') {
            return { skipped: true }
          }

          // Check if there's been activity since query
          if (fresh.lastHeartbeatAt && fresh.lastHeartbeatAt.toMillis() > suspendCutoff.toMillis()) {
            return { skipped: true } // Activity since query
          }

          // Suspend the VM
          if (agent.instanceName && agent.instanceZone) {
            await suspendInstance(agent.instanceName, agent.instanceZone)
          }

          // Update agent status
          await updateAgentStatus(agent.id, 'running', 'suspended', {})

          // eslint-disable-next-line no-console
          console.log(`Reaper: Suspended agent ${agent.id}`)
          return { action: 'suspended', agentId: agent.id }
        }
        catch (error) {
          console.error(`Reaper: Failed to suspend agent ${agent.id}:`, error instanceof Error ? error.message : 'Unknown error')
          return { skipped: true }
        }
      }),
      processInBatches(toStop, MAX_CONCURRENCY, async (agent) => {
        try {
          // Re-check freshness before acting
          const fresh = await getAgent(agent.id)
          if (!fresh || fresh.status !== 'suspended') {
            return { skipped: true }
          }

          // Stop the VM
          if (agent.instanceName && agent.instanceZone) {
            await stopInstance(agent.instanceName, agent.instanceZone)
          }

          // Update agent status with needsContinue flag
          await updateAgentStatus(agent.id, 'suspended', 'stopped', { needsContinue: true })

          // eslint-disable-next-line no-console
          console.log(`Reaper: Stopped agent ${agent.id}`)
          return { action: 'stopped', agentId: agent.id }
        }
        catch (error) {
          console.error(`Reaper: Failed to stop agent ${agent.id}:`, error instanceof Error ? error.message : 'Unknown error')
          return { skipped: true }
        }
      }),
    ])

    return { suspended: suspendResults, stopped: stopResults }
  }
  finally {
    await releaseLock(lockRef)
  }
}
