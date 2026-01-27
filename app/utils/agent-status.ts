/**
 * Agent status utilities - shared between client and server.
 *
 * This module contains pure functions for working with agent statuses
 * that can be safely imported in both client and server contexts.
 */

/**
 * Agent status values.
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
 * Legacy status values that may exist in old Firestore documents.
 * These are handled gracefully but should not be used for new agents.
 */
export type LegacyAgentStatus = 'cancelled' | 'completed'

/**
 * All possible status values including legacy ones.
 * Use this type when reading from Firestore where old data may exist.
 */
export type AnyAgentStatus = AgentStatus | LegacyAgentStatus

/**
 * Valid status transitions.
 * Terminal state (failed) has no outgoing transitions.
 * 'stopped' can transition back to 'running' when the VM is started.
 * Deletion is handled separately (not a status transition).
 */
const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  pending: ['provisioning', 'failed'],
  provisioning: ['running', 'failed'],
  running: ['suspended', 'stopped', 'failed'],
  suspended: ['running', 'stopped'],
  stopped: ['running'],
  failed: [],
}

/**
 * Gets valid next statuses for a given status.
 * Handles legacy statuses gracefully (returns empty array).
 *
 * @param status - Agent status (supports legacy values like 'cancelled')
 */
export function getValidTransitions(status: AnyAgentStatus): AgentStatus[] {
  // Handle legacy statuses from old data
  if (!(status in VALID_TRANSITIONS)) {
    return []
  }
  return VALID_TRANSITIONS[status as AgentStatus]
}

/**
 * Checks if a status is terminal (no outgoing transitions).
 * Legacy statuses like 'cancelled' are treated as terminal.
 *
 * @param status - Agent status (supports legacy values like 'cancelled')
 */
export function isTerminalStatus(status: AnyAgentStatus): boolean {
  // Legacy statuses are terminal
  if (!(status in VALID_TRANSITIONS)) {
    return true
  }
  return VALID_TRANSITIONS[status as AgentStatus].length === 0
}

/**
 * Checks if a status indicates the agent is active (requires polling).
 * Legacy statuses like 'cancelled' return false.
 *
 * @param status - Agent status (supports legacy values like 'cancelled')
 */
export function isActiveStatus(status: AnyAgentStatus): boolean {
  return ['pending', 'provisioning', 'running'].includes(status)
}
