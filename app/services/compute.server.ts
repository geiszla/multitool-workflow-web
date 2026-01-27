/**
 * Google Compute Engine Service.
 *
 * Manages GCE VMs for running Claude Code agents.
 *
 * Features:
 * - VM creation with Claude Code pre-configured
 * - Start/stop/suspend/resume operations
 * - Instance status monitoring
 * - Security: No external IP, least privilege service account
 */

import { InstancesClient, ZoneOperationsClient } from '@google-cloud/compute'
import { env, GCP_PROJECT_ID } from './env.server'

// Default configuration
const DEFAULT_ZONE = 'eu-west3-a'
const DEFAULT_MACHINE_TYPE = 'e2-medium'
const DEFAULT_DISK_SIZE_GB = 20
const NETWORK_NAME = 'default'
const AGENT_SERVICE_ACCOUNT = `agent-vm@${GCP_PROJECT_ID}.iam.gserviceaccount.com`

// Source image for the VM (pre-built with Claude Code and dependencies)
// Allow override via environment variable for rollback to specific image
const SOURCE_IMAGE = process.env.AGENT_SOURCE_IMAGE
  || 'projects/multitool-workflow-web/global/images/family/multitool-agent'

// Lazy-initialized clients
let instancesClient: InstancesClient | null = null
let operationsClient: ZoneOperationsClient | null = null

function getInstancesClient(): InstancesClient {
  if (!instancesClient) {
    instancesClient = new InstancesClient()
  }
  return instancesClient
}

function getOperationsClient(): ZoneOperationsClient {
  if (!operationsClient) {
    operationsClient = new ZoneOperationsClient()
  }
  return operationsClient
}

/**
 * Agent instance configuration.
 */
export interface AgentInstanceConfig {
  agentId: string
  userId: string
  repoOwner: string
  repoName: string
  branch: string
  issueNumber?: number
  instructions?: string
}

/**
 * Instance status from GCE.
 */
export type GceInstanceStatus
  = | 'PROVISIONING'
    | 'STAGING'
    | 'RUNNING'
    | 'STOPPING'
    | 'STOPPED'
    | 'SUSPENDING'
    | 'SUSPENDED'
    | 'REPAIRING'
    | 'TERMINATED'

/**
 * Instance information returned from operations.
 */
export interface InstanceInfo {
  name: string
  zone: string
  status: GceInstanceStatus
  internalIp?: string
}

/**
 * Async creation result with operation ID.
 */
export interface AsyncCreationResult {
  instanceName: string
  zone: string
  operationId: string
}

/**
 * Generates an instance name from agent ID.
 * Uses first 8 chars of UUID to fit GCE naming limits.
 */
function getInstanceName(agentId: string): string {
  const shortId = agentId.slice(0, 8)
  return `agent-${shortId}`
}

/**
 * Extracts zone name from zone URL.
 */
function parseZone(zoneUrl: string): string {
  const parts = zoneUrl.split('/')
  return parts[parts.length - 1]
}

/**
 * Waits for a zone operation to complete.
 * Polls every 2 seconds with a default 5 minute timeout.
 *
 * @param operationName - GCE operation name
 * @param zone - GCE zone
 * @param timeoutMs - Timeout in milliseconds (default 5 minutes)
 * @throws Error if operation fails or times out
 */
export async function waitForOperation(
  operationName: string,
  zone: string,
  timeoutMs = 300000, // 5 minutes default
): Promise<void> {
  const client = getOperationsClient()
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    const [operation] = await client.get({
      project: GCP_PROJECT_ID,
      zone,
      operation: operationName,
    })

    if (operation.status === 'DONE') {
      if (operation.error) {
        const errors = operation.error.errors || []
        const errorMsg = errors.map(e => e.message).join(', ')
        throw new Error(`Operation failed: ${errorMsg}`)
      }
      return
    }

    // Wait 2 seconds before polling again
    await new Promise(resolve => setTimeout(resolve, 2000))
  }

  throw new Error(`Operation timed out after ${timeoutMs}ms`)
}

/**
 * Creates a new GCE instance for an agent.
 *
 * @param config - Agent instance configuration
 * @param zone - GCE zone (default: eu-west3-a)
 * @returns Instance information
 */
export async function createAgentInstance(
  config: AgentInstanceConfig,
  zone = DEFAULT_ZONE,
): Promise<InstanceInfo> {
  const client = getInstancesClient()
  const instanceName = getInstanceName(config.agentId)

  // Build startup script that will configure the agent
  const startupScript = buildStartupScript(config)

  const [operation] = await client.insert({
    project: GCP_PROJECT_ID,
    zone,
    instanceResource: {
      name: instanceName,
      machineType: `zones/${zone}/machineTypes/${DEFAULT_MACHINE_TYPE}`,

      // Labels for identification and filtering
      // GCE label values must start with a lowercase letter, so we prefix with 'u-' and 'a-'
      labels: {
        'owner': `u-${config.userId.slice(0, 61).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        'agent': `a-${config.agentId.slice(0, 61).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        'managed-by': 'multitool-workflow-web',
      },

      // Metadata including agent configuration
      metadata: {
        items: [
          { key: 'agent-id', value: config.agentId },
          { key: 'user-id', value: config.userId },
          { key: 'startup-script', value: startupScript },
          // Note: Do NOT pass API keys in metadata - fetch via authenticated endpoint
        ],
      },

      // Boot disk
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: SOURCE_IMAGE,
            diskSizeGb: String(DEFAULT_DISK_SIZE_GB),
            diskType: `zones/${zone}/diskTypes/pd-ssd`,
          },
        },
      ],

      // Network - no external IP for security
      networkInterfaces: [
        {
          network: `global/networks/${NETWORK_NAME}`,
          // No accessConfigs = no external IP
          // Outbound traffic goes through Cloud NAT
        },
      ],

      // Service account with minimal permissions
      serviceAccounts: [
        {
          email: AGENT_SERVICE_ACCOUNT,
          scopes: [
            'https://www.googleapis.com/auth/cloud-platform',
          ],
        },
      ],

      // Scheduling options
      scheduling: {
        automaticRestart: true,
        onHostMaintenance: 'MIGRATE',
        preemptible: false, // Don't use preemptible for agents
      },
    },
  })

  // Wait for the operation to complete
  if (operation.name) {
    await waitForOperation(operation.name, zone)
  }

  return {
    name: instanceName,
    zone,
    status: 'PROVISIONING',
  }
}

/**
 * Creates a new GCE instance asynchronously without waiting for completion.
 * Returns operation ID for tracking provisioning status.
 *
 * @param config - Agent instance configuration
 * @param zone - GCE zone (default: eu-west3-a)
 * @returns Async creation result with operation ID
 */
export async function createAgentInstanceAsync(
  config: AgentInstanceConfig,
  zone = DEFAULT_ZONE,
): Promise<AsyncCreationResult> {
  const client = getInstancesClient()
  const instanceName = getInstanceName(config.agentId)

  // Build startup script that will configure the agent
  const startupScript = buildStartupScript(config)

  const [operation] = await client.insert({
    project: GCP_PROJECT_ID,
    zone,
    instanceResource: {
      name: instanceName,
      machineType: `zones/${zone}/machineTypes/${DEFAULT_MACHINE_TYPE}`,

      // Labels for identification and filtering
      labels: {
        'owner': `u-${config.userId.slice(0, 61).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        'agent': `a-${config.agentId.slice(0, 61).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        'managed-by': 'multitool-workflow-web',
      },

      // Metadata including agent configuration
      metadata: {
        items: [
          { key: 'agent-id', value: config.agentId },
          { key: 'user-id', value: config.userId },
          { key: 'startup-script', value: startupScript },
        ],
      },

      // Boot disk
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: SOURCE_IMAGE,
            diskSizeGb: String(DEFAULT_DISK_SIZE_GB),
            diskType: `zones/${zone}/diskTypes/pd-ssd`,
          },
        },
      ],

      // Network - no external IP for security
      networkInterfaces: [
        {
          network: `global/networks/${NETWORK_NAME}`,
          // No accessConfigs = no external IP
          // Outbound traffic goes through Cloud NAT
        },
      ],

      // Service account with minimal permissions
      serviceAccounts: [
        {
          email: AGENT_SERVICE_ACCOUNT,
          scopes: [
            'https://www.googleapis.com/auth/cloud-platform',
          ],
        },
      ],

      // Scheduling options
      scheduling: {
        automaticRestart: true,
        onHostMaintenance: 'MIGRATE',
        preemptible: false,
      },
    },
  })

  if (!operation.name) {
    throw new Error('GCE operation returned without name')
  }

  return {
    instanceName,
    zone,
    operationId: operation.name,
  }
}

/**
 * Checks the status of a GCE operation.
 *
 * @param operationId - Operation ID from createAgentInstanceAsync
 * @param zone - GCE zone
 * @returns Operation status and error if any
 */
export async function getOperationStatus(
  operationId: string,
  zone = DEFAULT_ZONE,
): Promise<{ done: boolean, error?: string }> {
  const client = getOperationsClient()

  const [operation] = await client.get({
    project: GCP_PROJECT_ID,
    zone,
    operation: operationId,
  })

  if (operation.status === 'DONE') {
    if (operation.error) {
      const errors = operation.error.errors || []
      const errorMsg = errors.map(e => e.message).join(', ')
      return { done: true, error: errorMsg }
    }
    return { done: true }
  }

  return { done: false }
}

/**
 * Validates and sanitizes a string value for safe shell embedding.
 * Only allows alphanumeric characters, hyphens, underscores, and periods.
 *
 * @param value - Value to sanitize
 * @param fieldName - Field name for error messages
 * @returns Sanitized value
 * @throws Error if value contains invalid characters
 */
function sanitizeShellValue(value: string, fieldName: string): string {
  // Only allow safe characters: alphanumeric, hyphen, underscore, period, forward slash
  // This is intentionally restrictive to prevent shell injection
  const safePattern = /^[\w.\-/]+$/
  if (!safePattern.test(value)) {
    throw new Error(`Invalid ${fieldName}: contains unsafe characters`)
  }
  return value
}

/**
 * Validates GitHub repository owner/name.
 * More permissive than sanitizeShellValue but still safe.
 */
function validateGitHubRef(value: string, fieldName: string): string {
  // GitHub usernames/orgs: alphanumeric and hyphen, no consecutive hyphens, no starting/ending hyphen
  // Repo names: alphanumeric, hyphen, underscore, period
  // Branch names: alphanumeric, hyphen, underscore, period, forward slash
  const safePattern = /^[a-z0-9][\w.\-/]*[a-z0-9]$|^[a-z0-9]$/i
  if (!safePattern.test(value)) {
    throw new Error(`Invalid ${fieldName}: "${value}" contains invalid characters`)
  }
  // Additional check for shell metacharacters that could cause issues
  const dangerousChars = /[`$\\"';&|<>(){}[\]!#*?~]/
  if (dangerousChars.test(value)) {
    throw new Error(`Invalid ${fieldName}: contains shell metacharacters`)
  }
  return value
}

/**
 * Validates that a value is a positive integer (for issue numbers).
 */
function validatePositiveInteger(value: number | undefined, fieldName: string): string {
  if (value === undefined) {
    return ''
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${fieldName}: must be a positive integer`)
  }
  return String(value)
}

/**
 * Builds the startup script for the agent VM.
 *
 * This minimal startup script runs on each VM boot and:
 * 1. Creates /etc/default/agent-env with user-specific configuration
 * 2. Enables and starts the pre-installed systemd services
 *
 * The pre-built image already contains:
 * - Node.js 24, Claude CLI, npm dependencies
 * - systemd service files (disabled by default)
 * - bootstrap.js and pty-server.js scripts
 *
 * Security: All user-provided values are validated before embedding in the
 * shell script to prevent injection attacks.
 */
function buildStartupScript(config: AgentInstanceConfig): string {
  const cloudRunUrl = env.APP_URL

  // Validate all user-provided inputs before embedding in shell script
  const safeAgentId = sanitizeShellValue(config.agentId, 'agentId')
  const safeUserId = sanitizeShellValue(config.userId, 'userId')
  const safeRepoOwner = validateGitHubRef(config.repoOwner, 'repoOwner')
  const safeRepoName = validateGitHubRef(config.repoName, 'repoName')
  const safeBranch = validateGitHubRef(config.branch, 'branch')
  const safeIssueNumber = validatePositiveInteger(config.issueNumber, 'issueNumber')

  // Also validate cloudRunUrl (should be a valid HTTPS URL)
  if (!cloudRunUrl || !cloudRunUrl.startsWith('https://')) {
    throw new Error('Invalid APP_URL: must be an HTTPS URL')
  }

  return `#!/bin/bash
set -e

# Log to Cloud Logging
exec > >(logger -t agent-startup) 2>&1

echo "=== Agent VM Startup Script ==="
echo "Agent ID: ${safeAgentId}"
echo "Repository: ${safeRepoOwner}/${safeRepoName}"
echo "Branch: ${safeBranch}"

# Create environment file for services
# Values are pre-validated (alphanumeric, hyphen, underscore, period, slash only)
# so heredoc expansion is safe
cat > /etc/default/agent-env <<EOF
AGENT_ID=${safeAgentId}
USER_ID=${safeUserId}
CLOUD_RUN_URL=${cloudRunUrl}
REPO_OWNER=${safeRepoOwner}
REPO_NAME=${safeRepoName}
BRANCH=${safeBranch}
ISSUE_NUMBER=${safeIssueNumber}
EOF
chmod 600 /etc/default/agent-env

# Enable and start services
# Note: agent-bootstrap.service will only run if marker file doesn't exist
systemctl daemon-reload
systemctl enable agent-bootstrap.service pty-server.service
systemctl start pty-server.service

echo "=== Agent VM Startup Script Complete ==="
`
}

/**
 * Starts a stopped instance.
 *
 * @param instanceName - Instance name
 * @param zone - GCE zone
 */
export async function startInstance(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<void> {
  const client = getInstancesClient()

  const [operation] = await client.start({
    project: GCP_PROJECT_ID,
    zone,
    instance: instanceName,
  })

  if (operation.name) {
    await waitForOperation(operation.name, zone)
  }
}

/**
 * Stops an instance (preserves disk, discards memory).
 *
 * @param instanceName - Instance name
 * @param zone - GCE zone
 */
export async function stopInstance(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<void> {
  const client = getInstancesClient()

  const [operation] = await client.stop({
    project: GCP_PROJECT_ID,
    zone,
    instance: instanceName,
  })

  if (operation.name) {
    await waitForOperation(operation.name, zone)
  }
}

/**
 * Stops an instance without waiting for completion.
 * Used for non-blocking VM shutdown (e.g., after agent exit).
 *
 * @param instanceName - Instance name
 * @param zone - GCE zone
 */
export async function stopInstanceAsync(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<void> {
  const client = getInstancesClient()

  try {
    await client.stop({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    })
    // eslint-disable-next-line no-console
    console.log(`Initiated async stop for instance ${instanceName}`)
  }
  catch (error) {
    // Log but don't throw - this is fire-and-forget
    console.error(`Failed to initiate stop for ${instanceName}:`, error)
  }
}

/**
 * Suspends an instance (preserves memory state, quick resume).
 *
 * @param instanceName - Instance name
 * @param zone - GCE zone
 */
export async function suspendInstance(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<void> {
  const client = getInstancesClient()

  const [operation] = await client.suspend({
    project: GCP_PROJECT_ID,
    zone,
    instance: instanceName,
  })

  if (operation.name) {
    await waitForOperation(operation.name, zone)
  }
}

/**
 * Resumes a suspended instance.
 *
 * @param instanceName - Instance name
 * @param zone - GCE zone
 */
export async function resumeInstance(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<void> {
  const client = getInstancesClient()

  const [operation] = await client.resume({
    project: GCP_PROJECT_ID,
    zone,
    instance: instanceName,
  })

  if (operation.name) {
    await waitForOperation(operation.name, zone)
  }
}

/**
 * Deletes an instance.
 *
 * Treats 404 (instance not found) as success - the VM is already gone.
 * This makes the operation idempotent and handles cases where:
 * - VM was already deleted externally
 * - Retry after partial failure
 *
 * @param instanceName - Instance name
 * @param zone - GCE zone
 */
export async function deleteInstance(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<void> {
  const client = getInstancesClient()

  try {
    const [operation] = await client.delete({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    })

    if (operation.name) {
      await waitForOperation(operation.name, zone)
    }
  }
  catch (error) {
    // Treat 404 as success - VM is already gone
    if ((error as { code?: number }).code === 404) {
      // eslint-disable-next-line no-console
      console.log(`Instance ${instanceName} not found (404), treating as already deleted`)
      return
    }
    throw error
  }
}

/**
 * Gets the status of an instance.
 *
 * @param instanceName - Instance name
 * @param zone - GCE zone
 * @returns Instance info or null if not found
 */
export async function getInstanceStatus(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<InstanceInfo | null> {
  const client = getInstancesClient()

  try {
    const [instance] = await client.get({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    })

    // Extract internal IP from network interfaces
    let internalIp: string | undefined
    if (instance.networkInterfaces && instance.networkInterfaces.length > 0) {
      internalIp = instance.networkInterfaces[0].networkIP ?? undefined
    }

    return {
      name: instance.name || instanceName,
      zone: instance.zone ? parseZone(instance.zone) : zone,
      status: (instance.status || 'UNKNOWN') as GceInstanceStatus,
      internalIp,
    }
  }
  catch (error) {
    if ((error as { code?: number }).code === 404) {
      return null
    }
    throw error
  }
}

/**
 * Lists all agent instances for cleanup or monitoring.
 *
 * @returns List of agent instances
 */
export async function listAgentInstances(): Promise<InstanceInfo[]> {
  const client = getInstancesClient()

  const [instances] = await client.list({
    project: GCP_PROJECT_ID,
    zone: DEFAULT_ZONE,
    filter: 'labels.managed-by=multitool-workflow-web',
  })

  return (instances || []).map(instance => ({
    name: instance.name || '',
    zone: instance.zone ? parseZone(instance.zone) : DEFAULT_ZONE,
    status: (instance.status || 'UNKNOWN') as GceInstanceStatus,
  }))
}
