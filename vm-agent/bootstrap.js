#!/usr/bin/env node
/**
 * Agent Bootstrap Service.
 *
 * This is a oneshot service that runs when the VM starts.
 * It fetches credentials, clones the repository, and updates status.
 *
 * Environment variables (set by startup script):
 * - AGENT_ID: The agent UUID
 * - USER_ID: The user UUID
 * - CLOUD_RUN_URL: The Cloud Run service URL
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AGENT_ID = process.env.AGENT_ID
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL
const WORK_DIR = join(homedir(), 'workspace')

/**
 * Log with timestamp and level.
 */
function log(level, message, data = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    agentId: AGENT_ID,
    ...data,
  }))
}

/**
 * Get GCE instance identity token.
 */
async function getIdentityToken() {
  const metadataUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
  const audience = CLOUD_RUN_URL

  const response = await fetch(`${metadataUrl}?audience=${encodeURIComponent(audience)}`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })

  if (!response.ok) {
    throw new Error(`Failed to get identity token: ${response.status}`)
  }

  return response.text()
}

/**
 * Fetch credentials from Cloud Run.
 */
async function fetchCredentials() {
  log('info', 'Fetching credentials from Cloud Run')

  const token = await getIdentityToken()
  const url = `${CLOUD_RUN_URL}/api/agents/${AGENT_ID}/credentials`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to fetch credentials: ${response.status} ${text}`)
  }

  return response.json()
}

/**
 * Update agent status via Cloud Run.
 */
async function updateStatus(updates) {
  log('info', 'Updating agent status', updates)

  const token = await getIdentityToken()
  const url = `${CLOUD_RUN_URL}/api/agents/${AGENT_ID}/status`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  })

  if (!response.ok) {
    const text = await response.text()
    log('error', `Failed to update status: ${response.status} ${text}`)
  }
}

/**
 * Clone the repository.
 *
 * Security: Uses GIT_ASKPASS to provide credentials via environment variables.
 * This prevents token leakage in:
 * - Command line arguments (visible via ps)
 * - .git/config (would persist the token on disk)
 * - Git credential cache
 */
async function cloneRepository(credentials) {
  const { githubToken, repoOwner, repoName, branch } = credentials

  log('info', 'Cloning repository', { repoOwner, repoName, branch })

  await updateStatus({ cloneStatus: 'cloning' })

  // Create workspace directory
  if (!existsSync(WORK_DIR)) {
    mkdirSync(WORK_DIR, { recursive: true })
  }

  const repoDir = join(WORK_DIR, repoName)

  // Use HTTPS URL without embedded credentials
  const cloneUrl = `https://github.com/${repoOwner}/${repoName}.git`

  // Create a temporary askpass script that provides credentials from environment
  const askpassScript = join(WORK_DIR, '.git-askpass.sh')
  writeFileSync(askpassScript, `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  Password*) echo "$GIT_TOKEN" ;;
esac
`, { mode: 0o700 })

  try {
    // Clone using GIT_ASKPASS - credentials are provided via environment,
    // not persisted anywhere on disk
    const gitEnv = {
      ...process.env,
      GIT_ASKPASS: askpassScript,
      GIT_TOKEN: githubToken,
      GIT_TERMINAL_PROMPT: '0',
    }

    execSync(`git clone --branch "${branch}" --single-branch "${cloneUrl}" "${repoDir}"`, {
      cwd: WORK_DIR,
      stdio: 'pipe',
      timeout: 300000, // 5 minute timeout
      env: gitEnv,
    })

    // Configure git for commits
    execSync('git config user.email "agent@multitool-workflow.web"', { cwd: repoDir })
    execSync('git config user.name "Multitool Agent"', { cwd: repoDir })

    // Store the askpass script path for later use (push operations)
    // The actual token is NOT stored - it will be re-fetched if needed
    execSync(`git config credential.helper ""`, { cwd: repoDir })

    log('info', 'Repository cloned successfully')
    await updateStatus({ cloneStatus: 'completed' })

    // Clean up askpass script (token was in env, not in script)
    // Keep it for later git operations that may need auth

    return repoDir
  }
  catch (error) {
    // Sanitize error message to avoid logging credentials
    const safeErrorMsg = error.message
      .replace(githubToken, '[REDACTED]')
      .replace(/password=\S+/gi, 'password=[REDACTED]')
      .replace(/GIT_TOKEN=\S+/gi, 'GIT_TOKEN=[REDACTED]')
    log('error', 'Failed to clone repository', { error: safeErrorMsg })
    await updateStatus({
      cloneStatus: 'failed',
      cloneError: safeErrorMsg,
    })
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

/**
 * Write Claude API key to config.
 * Claude Code reads the API key from environment or config file.
 */
function configureClaudeCode(credentials) {
  const { claudeApiKey } = credentials

  // Set ANTHROPIC_API_KEY environment variable via systemd override
  const envFile = '/etc/default/pty-server'
  writeFileSync(envFile, `ANTHROPIC_API_KEY=${claudeApiKey}\n`, { mode: 0o600 })

  log('info', 'Claude Code configured')
}

// NOTE: internalIp is NOT sent to status endpoint for security
// The server fetches it from GCE metadata API when needed

/**
 * Main bootstrap flow.
 */
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
    // Fetch credentials
    const credentials = await fetchCredentials()

    // Configure Claude Code
    configureClaudeCode(credentials)

    // Clone repository
    const repoDir = await cloneRepository(credentials)

    // Write repo directory for pty-server to use
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
      errorMessage: `Bootstrap failed: ${error.message}`,
    })
    process.exit(1)
  }
}

main()
