/**
 * Agent Realtime Hook.
 *
 * Subscribes to realtime updates for an agent from Firestore.
 * Uses Firebase client SDK for efficient realtime subscriptions.
 */

import type { Timestamp } from 'firebase/firestore'
import type { AnyAgentStatus } from '~/utils/agent-status'
import { useCallback, useEffect, useState } from 'react'
import { useFirebaseAuth } from './useFirebaseAuth'

// Re-export types from shared utility
export type { AgentStatus, AnyAgentStatus, LegacyAgentStatus } from '~/utils/agent-status'
export { getValidTransitions, isActiveStatus, isTerminalStatus } from '~/utils/agent-status'

/**
 * Agent data from Firestore realtime subscription.
 * Only includes fields that clients can read (excludes internalIp).
 * Uses AnyAgentStatus to support legacy status values from old data.
 */
export interface RealtimeAgent {
  id: string
  userId: string
  title: string
  status: AnyAgentStatus
  statusVersion: number

  // Target configuration
  repoOwner: string
  repoName: string
  branch: string
  issueNumber?: number
  issueTitle?: string

  // Agent configuration
  instructions?: string

  // Execution metadata
  startedAt?: Timestamp
  suspendedAt?: Timestamp
  stoppedAt?: Timestamp
  errorMessage?: string

  // Instance info (excludes internalIp for security)
  instanceName?: string
  instanceZone?: string
  instanceStatus?: string

  // Terminal state
  terminalReady?: boolean

  // Clone status
  cloneStatus?: 'pending' | 'cloning' | 'completed' | 'failed'
  cloneError?: string

  // Resume tracking
  needsResume?: boolean

  // Timestamps
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * Hook result type.
 */
interface UseAgentRealtimeResult {
  agent: RealtimeAgent | null
  loading: boolean
  error: Error | null
}

/**
 * Hook to subscribe to realtime agent updates.
 *
 * @param agentId - Agent UUID to subscribe to
 * @returns Agent data, loading state, and error
 */
export function useAgentRealtime(agentId: string): UseAgentRealtimeResult {
  const { authenticated, loading: authLoading } = useFirebaseAuth()
  const [agent, setAgent] = useState<RealtimeAgent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const subscribe = useCallback(async () => {
    if (!authenticated || !agentId) {
      return undefined
    }

    try {
      // Dynamically import Firestore (client-only)
      const { getClientFirestore } = await import('~/services/firebase.client')
      const { doc, onSnapshot } = await import('firebase/firestore')

      const db = getClientFirestore()
      const agentRef = doc(db, 'agents', agentId)

      // Subscribe to realtime updates
      const unsubscribe = onSnapshot(
        agentRef,
        (docSnapshot) => {
          if (docSnapshot.exists()) {
            const data = docSnapshot.data() as RealtimeAgent
            setAgent({ ...data, id: docSnapshot.id })
            setLoading(false)
            setError(null)
          }
          else {
            setAgent(null)
            setLoading(false)
            setError(new Error('Agent not found'))
          }
        },
        (err) => {
          console.error('Firestore subscription error:', err)
          setError(err)
          setLoading(false)
        },
      )

      return unsubscribe
    }
    catch (err) {
      console.error('Failed to set up Firestore subscription:', err)
      setError(err instanceof Error ? err : new Error('Unknown error'))
      setLoading(false)
      return undefined
    }
  }, [authenticated, agentId])

  useEffect(() => {
    // Wait for auth to complete
    if (authLoading) {
      return
    }

    let unsubscribe: (() => void) | undefined

    subscribe().then((unsub) => {
      unsubscribe = unsub
    })

    return () => {
      if (unsubscribe) {
        unsubscribe()
      }
    }
  }, [subscribe, authLoading])

  return { agent, loading: loading || authLoading, error }
}

/**
 * Checks if agent status is active (requires terminal connection).
 */
export function isAgentActive(status: AnyAgentStatus): boolean {
  return ['running'].includes(status)
}

/**
 * Checks if agent can be resumed.
 */
export function canResumeAgent(status: AnyAgentStatus): boolean {
  return ['suspended', 'stopped'].includes(status)
}
