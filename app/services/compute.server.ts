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
 * Builds the startup script for the agent VM.
 * This script installs dependencies and sets up systemd services.
 *
 * Security: All user-provided values are validated before embedding.
 */
function buildStartupScript(config: AgentInstanceConfig): string {
  const cloudRunUrl = env.APP_URL

  // Validate all user-provided inputs before embedding in shell script
  const safeAgentId = sanitizeShellValue(config.agentId, 'agentId')
  const safeUserId = sanitizeShellValue(config.userId, 'userId')
  const safeRepoOwner = validateGitHubRef(config.repoOwner, 'repoOwner')
  const safeRepoName = validateGitHubRef(config.repoName, 'repoName')
  const safeBranch = validateGitHubRef(config.branch, 'branch')
  const safeIssueNumber = config.issueNumber ? String(config.issueNumber) : ''

  return `#!/bin/bash
set -e

# Log to Cloud Logging
exec > >(logger -t agent-startup) 2>&1

echo "=== Agent VM Startup Script ==="
echo "Agent ID: ${safeAgentId}"
echo "User ID: ${safeUserId}"
echo "Repository: ${safeRepoOwner}/${safeRepoName}"
echo "Branch: ${safeBranch}"
${safeIssueNumber ? `echo "Issue: #${safeIssueNumber}"` : ''}

# Export environment variables for systemd services
mkdir -p /etc/default
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

# Create environment file for pty-server (API keys will be added by bootstrap)
touch /etc/default/pty-server
chmod 600 /etc/default/pty-server

# Install Node.js 24 LTS
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# Install build dependencies for node-pty
apt-get install -y build-essential python3

# Install git and jq
apt-get install -y git jq

# Create agent user
useradd -m -s /bin/bash agent || true

# Create workspace directory
mkdir -p /home/agent/workspace
chown agent:agent /home/agent/workspace

# Create vm-agent directory
mkdir -p /opt/vm-agent
cd /opt/vm-agent

# Create package.json
cat > package.json <<'PACKAGE_EOF'
{
  "name": "vm-agent",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "node-pty": "^1.0.0",
    "ws": "^8.18.0"
  }
}
PACKAGE_EOF

# Create bootstrap.js
cat > bootstrap.js <<'BOOTSTRAP_EOF'
${buildBootstrapScript()}
BOOTSTRAP_EOF

# Create pty-server.js
cat > pty-server.js <<'PTY_EOF'
${buildPtyServerScript()}
PTY_EOF

# Install npm dependencies
npm install

# Create agent-bootstrap.service (oneshot)
cat > /etc/systemd/system/agent-bootstrap.service <<'SERVICE_EOF'
[Unit]
Description=Agent Bootstrap Service
After=network-online.target
Wants=network-online.target
Before=pty-server.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=agent
WorkingDirectory=/opt/vm-agent
EnvironmentFile=/etc/default/agent-env
ExecStart=/usr/bin/node bootstrap.js
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE_EOF

# Create pty-server.service (long-running)
cat > /etc/systemd/system/pty-server.service <<'SERVICE_EOF'
[Unit]
Description=PTY WebSocket Server
After=agent-bootstrap.service
Requires=agent-bootstrap.service

[Service]
Type=simple
User=agent
WorkingDirectory=/opt/vm-agent
EnvironmentFile=/etc/default/agent-env
EnvironmentFile=/etc/default/pty-server
ExecStart=/usr/bin/node pty-server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE_EOF

# Set permissions
chown -R agent:agent /opt/vm-agent

# Reload and enable services
systemctl daemon-reload
systemctl enable agent-bootstrap.service
systemctl enable pty-server.service

# Start the bootstrap service (which will then start pty-server)
systemctl start agent-bootstrap.service

echo "=== Agent VM Startup Script Complete ==="
`
}

/**
 * Generates the inline bootstrap script for embedding in startup script.
 */
function buildBootstrapScript(): string {
  // Escaped version that can be embedded in heredoc
  return `#!/usr/bin/env node
/**
 * Agent Bootstrap Service - Embedded in VM startup script
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AGENT_ID = process.env.AGENT_ID
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL
const WORK_DIR = join(homedir(), 'workspace')

function log(level, message, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    agentId: AGENT_ID,
    ...data,
  }))
}

async function getIdentityToken() {
  const metadataUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
  const audience = CLOUD_RUN_URL

  const response = await fetch(\\\`\\\${metadataUrl}?audience=\\\${encodeURIComponent(audience)}\\\`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })

  if (!response.ok) {
    throw new Error(\\\`Failed to get identity token: \\\${response.status}\\\`)
  }

  return response.text()
}

async function fetchCredentials() {
  log('info', 'Fetching credentials from Cloud Run')

  const token = await getIdentityToken()
  const url = \\\`\\\${CLOUD_RUN_URL}/api/agents/\\\${AGENT_ID}/credentials\\\`

  const response = await fetch(url, {
    headers: { Authorization: \\\`Bearer \\\${token}\\\` },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(\\\`Failed to fetch credentials: \\\${response.status} \\\${text}\\\`)
  }

  return response.json()
}

async function updateStatus(updates) {
  log('info', 'Updating agent status', updates)

  const token = await getIdentityToken()
  const url = \\\`\\\${CLOUD_RUN_URL}/api/agents/\\\${AGENT_ID}/status\\\`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: \\\`Bearer \\\${token}\\\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  })

  if (!response.ok) {
    const text = await response.text()
    log('error', \\\`Failed to update status: \\\${response.status} \\\${text}\\\`)
  }
}

async function cloneRepository(credentials) {
  const { githubToken, repoOwner, repoName, branch } = credentials

  log('info', 'Cloning repository', { repoOwner, repoName, branch })

  await updateStatus({ cloneStatus: 'cloning' })

  if (!existsSync(WORK_DIR)) {
    mkdirSync(WORK_DIR, { recursive: true })
  }

  const repoDir = join(WORK_DIR, repoName)

  // Use HTTPS URL without embedded credentials
  const cloneUrl = \\\`https://github.com/\\\${repoOwner}/\\\${repoName}.git\\\`

  // Create a temporary askpass script that provides credentials from environment
  const askpassScript = join(WORK_DIR, '.git-askpass.sh')
  writeFileSync(askpassScript, \\\`#!/bin/sh
case "\\$1" in
  Username*) echo "x-access-token" ;;
  Password*) echo "\\$GIT_TOKEN" ;;
esac
\\\`, { mode: 0o700 })

  try {
    // Clone using GIT_ASKPASS - credentials are provided via environment,
    // not persisted anywhere on disk
    const gitEnv = {
      ...process.env,
      GIT_ASKPASS: askpassScript,
      GIT_TOKEN: githubToken,
      GIT_TERMINAL_PROMPT: '0',
    }

    execSync(\\\`git clone --branch "\\\${branch}" --single-branch "\\\${cloneUrl}" "\\\${repoDir}"\\\`, {
      cwd: WORK_DIR,
      stdio: 'pipe',
      timeout: 300000,
      env: gitEnv,
    })

    // Configure git for commits
    execSync('git config user.email "agent@multitool-workflow.web"', { cwd: repoDir })
    execSync('git config user.name "Multitool Agent"', { cwd: repoDir })

    // Disable credential helper - we don't want tokens stored on disk
    execSync('git config credential.helper ""', { cwd: repoDir })

    log('info', 'Repository cloned successfully')
    await updateStatus({ cloneStatus: 'completed' })

    return repoDir
  }
  catch (error) {
    // Sanitize error message to avoid logging credentials
    const safeErrorMsg = error.message
      .replace(githubToken, '[REDACTED]')
      .replace(/password=[^\\s]+/gi, 'password=[REDACTED]')
      .replace(/GIT_TOKEN=[^\\s]+/gi, 'GIT_TOKEN=[REDACTED]')
    log('error', 'Failed to clone repository', { error: safeErrorMsg })
    await updateStatus({ cloneStatus: 'failed', cloneError: safeErrorMsg })
    throw new Error(safeErrorMsg)
  }
  finally {
    // Clean up askpass script
    try {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(askpassScript)
    }
    catch {
      // Ignore cleanup errors
    }
  }
}

function configureClaudeCode(credentials) {
  const { claudeApiKey, codexApiKey } = credentials

  // Append API keys to pty-server env file
  appendFileSync('/etc/default/pty-server', \\\`ANTHROPIC_API_KEY=\\\${claudeApiKey}\\n\\\`)
  if (codexApiKey) {
    appendFileSync('/etc/default/pty-server', \\\`OPENAI_API_KEY=\\\${codexApiKey}\\n\\\`)
  }

  log('info', 'Claude Code configured')
}

// NOTE: internalIp is NOT sent to status endpoint for security
// The server fetches it from GCE metadata API when needed

async function main() {
  log('info', 'Bootstrap starting')

  if (!AGENT_ID) {
    log('error', 'AGENT_ID not set')
    process.exit(1)
  }

  if (!CLOUD_RUN_URL) {
    log('error', 'CLOUD_RUN_URL not set')
    process.exit(1)
  }

  try {
    const credentials = await fetchCredentials()

    configureClaudeCode(credentials)

    const repoDir = await cloneRepository(credentials)

    writeFileSync('/tmp/agent-repo-dir', repoDir)
    writeFileSync('/tmp/agent-credentials', JSON.stringify({
      needsResume: credentials.needsResume,
      issueNumber: credentials.issueNumber,
      instructions: credentials.instructions,
    }))

    // Transition to running - server will fetch internalIp from GCE
    await updateStatus({ status: 'running' })

    log('info', 'Bootstrap completed successfully')
  }
  catch (error) {
    log('error', 'Bootstrap failed', { error: error.message })
    await updateStatus({
      status: 'failed',
      errorMessage: \\\`Bootstrap failed: \\\${error.message}\\\`,
    })
    process.exit(1)
  }
}

main()
`
}

/**
 * Generates the inline PTY server script for embedding in startup script.
 * This is a placeholder - the full implementation is in Task 7.
 */
function buildPtyServerScript(): string {
  return `#!/usr/bin/env node
/**
 * PTY WebSocket Server - Embedded in VM startup script
 * See vm-agent/pty-server.js for the full implementation
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'

const PORT = 8080
const AGENT_ID = process.env.AGENT_ID
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL

function log(level, message, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    agentId: AGENT_ID,
    ...data,
  }))
}

// Wait for bootstrap to complete
function waitForBootstrap() {
  return new Promise((resolve) => {
    const check = () => {
      if (existsSync('/tmp/agent-repo-dir')) {
        resolve()
      } else {
        setTimeout(check, 1000)
      }
    }
    check()
  })
}

async function getIdentityToken() {
  const metadataUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
  const audience = CLOUD_RUN_URL

  const response = await fetch(\\\`\\\${metadataUrl}?audience=\\\${encodeURIComponent(audience)}\\\`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })

  if (!response.ok) {
    throw new Error(\\\`Failed to get identity token: \\\${response.status}\\\`)
  }

  return response.text()
}

async function updateStatus(updates) {
  try {
    const token = await getIdentityToken()
    const url = \\\`\\\${CLOUD_RUN_URL}/api/agents/\\\${AGENT_ID}/status\\\`

    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: \\\`Bearer \\\${token}\\\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    })
  } catch (error) {
    log('error', 'Failed to update status', { error: error.message })
  }
}

async function main() {
  log('info', 'PTY server starting')

  await waitForBootstrap()

  const repoDir = readFileSync('/tmp/agent-repo-dir', 'utf8').trim()
  let credentialsInfo = {}
  if (existsSync('/tmp/agent-credentials')) {
    credentialsInfo = JSON.parse(readFileSync('/tmp/agent-credentials', 'utf8'))
  }

  log('info', 'Repo directory', { repoDir })

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'healthy', agentId: AGENT_ID }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  const wss = new WebSocketServer({ server })

  let ptyProcess = null

  wss.on('connection', (ws) => {
    log('info', 'WebSocket connection established')

    if (ptyProcess) {
      log('warn', 'PTY process already exists, closing old connection')
      ws.close(1008, 'Session already active')
      return
    }

    // Build Claude Code command
    const claudeArgs = ['--dangerously-skip-permissions']
    if (credentialsInfo.needsResume) {
      claudeArgs.push('--resume')
    }

    ptyProcess = pty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: repoDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    })

    log('info', 'PTY process started', { pid: ptyProcess.pid })

    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stdout', data }))
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      log('info', 'PTY process exited', { exitCode })
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
        ws.close()
      }
      ptyProcess = null

      // Update agent status based on exit code
      if (exitCode === 0) {
        updateStatus({ status: 'completed' })
      } else {
        updateStatus({ status: 'failed', errorMessage: \\\`Claude Code exited with code \\\${exitCode}\\\` })
      }
    })

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString())

        switch (msg.type) {
          case 'stdin':
            if (ptyProcess) {
              ptyProcess.write(msg.data)
            }
            break
          case 'resize':
            if (ptyProcess && msg.cols && msg.rows) {
              ptyProcess.resize(msg.cols, msg.rows)
            }
            break
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }))
            break
        }
      } catch (error) {
        log('error', 'Failed to parse message', { error: error.message })
      }
    })

    ws.on('close', () => {
      log('info', 'WebSocket connection closed')
      // Note: We don't kill the PTY process on disconnect
      // This allows reconnection without losing the session
    })

    ws.on('error', (error) => {
      log('error', 'WebSocket error', { error: error.message })
    })
  })

  server.listen(PORT, '0.0.0.0', async () => {
    log('info', \\\`PTY server listening on port \\\${PORT}\\\`)
    await updateStatus({ terminalReady: true })
  })

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down')
    if (ptyProcess) {
      ptyProcess.kill()
    }
    server.close(() => {
      process.exit(0)
    })
  })
}

main()
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
