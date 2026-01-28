/**
 * Agent status utilities - shared between client and server.
 *
 * This module contains pure functions for working with agent statuses
 * that can be safely imported in both client and server contexts.
 */

/**
 * Agent status values.
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
  pending: ['provisioning', 'failed'],
  provisioning: ['running', 'failed'],
  running: ['suspended', 'stopped', 'failed'],
  suspended: ['running', 'stopped'],
  stopped: ['running'],
  failed: [],
}

/**
 * Gets valid next statuses for a given status.
 *
 * @param status - Agent status
 */
export function getValidTransitions(status: AgentStatus): AgentStatus[] {
  return VALID_TRANSITIONS[status as AgentStatus]
}

/**
 * Checks if a status is terminal (no outgoing transitions).
 *
 * @param status - Agent status
 */
export function isTerminalStatus(status: AgentStatus): boolean {
  return VALID_TRANSITIONS[status as AgentStatus].length === 0
}

/**
 * Checks if a status indicates the agent is active (requires polling).
 * Legacy statuses like 'cancelled' return false.
 *
 * @param status - Agent status (supports legacy values like 'cancelled')
 */
export function isActiveStatus(status: AgentStatus): boolean {
  return ['pending', 'provisioning', 'running'].includes(status)
}
