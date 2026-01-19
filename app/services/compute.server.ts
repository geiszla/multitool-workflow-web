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
import { GCP_PROJECT_ID } from './env.server'

// Default configuration
const DEFAULT_ZONE = 'eu-west3-a'
const DEFAULT_MACHINE_TYPE = 'e2-medium'
const DEFAULT_DISK_SIZE_GB = 20
const NETWORK_NAME = 'default'
const AGENT_SERVICE_ACCOUNT = `agent-vm@${GCP_PROJECT_ID}.iam.gserviceaccount.com`

// Source image for the VM (should have Claude Code pre-installed)
// This would be a custom image in production
const SOURCE_IMAGE = 'projects/debian-cloud/global/images/family/debian-12'

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
 */
async function waitForOperation(
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
 * Builds the startup script for the agent VM.
 */
function buildStartupScript(config: AgentInstanceConfig): string {
  // This script runs when the VM starts
  // It should fetch credentials from an authenticated Cloud Run endpoint,
  // clone the repo, and start Claude Code
  return `#!/bin/bash
set -e

# Log to Cloud Logging
exec > >(logger -t agent-startup) 2>&1

echo "Agent startup: ${config.agentId}"
echo "Repository: ${config.repoOwner}/${config.repoName}"
echo "Branch: ${config.branch}"
${config.issueNumber ? `echo "Issue: #${config.issueNumber}"` : ''}

# TODO: Implement actual agent startup logic
# 1. Fetch credentials from authenticated Cloud Run endpoint
# 2. Clone repository
# 3. Start Claude Code agent
# 4. Report status back to Cloud Run

echo "Agent startup script completed"
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
 * @param instanceName - Instance name
 * @param zone - GCE zone
 */
export async function deleteInstance(
  instanceName: string,
  zone = DEFAULT_ZONE,
): Promise<void> {
  const client = getInstancesClient()

  const [operation] = await client.delete({
    project: GCP_PROJECT_ID,
    zone,
    instance: instanceName,
  })

  if (operation.name) {
    await waitForOperation(operation.name, zone)
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

    return {
      name: instance.name || instanceName,
      zone: instance.zone ? parseZone(instance.zone) : zone,
      status: (instance.status || 'UNKNOWN') as GceInstanceStatus,
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
