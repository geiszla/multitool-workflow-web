#!/usr/bin/env node
/**
 * Agent Bootstrap Service
 *
 * This script runs once on initial VM provisioning to:
 * 1. Fetch credentials from Cloud Run using GCE identity token
 * 2. Clone the target repository
 * 3. Update agent status to 'running'
 *
 * Note: MCP server configuration has been moved to provision.sh (baked into VM image).
 * Figma MCP is added dynamically by pty-server.js if figmaApiKey is available.
 *
 * Security:
 * - Credentials fetched via authenticated endpoint (not stored on disk)
 * - GitHub token used via GIT_ASKPASS (not embedded in URLs)
 * - API keys held in memory only, never written to disk
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const AGENT_ID = process.env.AGENT_ID
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL
const WORK_DIR = join(homedir(), 'workspace')
// State directory managed by systemd StateDirectory=agent-bootstrap
const STATE_DIR = '/var/lib/agent-bootstrap'

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

  const response = await fetch(`${metadataUrl}?audience=${encodeURIComponent(audience)}&format=full`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })

  if (!response.ok) {
    throw new Error(`Failed to get identity token: ${response.status}`)
  }

  return response.text()
}

async function fetchCredentials() {
  log('info', 'Fetching credentials from Cloud Run')

  const token = await getIdentityToken()
  const url = `${CLOUD_RUN_URL}/api/agents/${AGENT_ID}/credentials`

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to fetch credentials: ${response.status} ${text}`)
  }

  return response.json()
}

/**
 * Updates agent status via Cloud Run API.
 * Returns true on success, false on failure.
 * This allows callers to make decisions based on whether the update succeeded.
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
    return false
  }
  return true
}

/**
 * Validates a GitHub owner or repository name.
 * These cannot contain slashes (unlike branch names).
 */
function validateGitHubOwnerOrRepo(value, fieldName) {
  // GitHub usernames/orgs: alphanumeric and hyphen, 1-39 chars
  // Repo names: alphanumeric, hyphen, underscore, period, 1-100 chars
  // Neither can contain slashes
  const safePattern = /^[a-zA-Z0-9][\w.-]*$/
  if (!safePattern.test(value) || value.length > 100) {
    throw new Error(`Invalid ${fieldName}: contains invalid characters or too long`)
  }
  // Additional check for dangerous patterns
  if (value.includes('..') || value.startsWith('-')) {
    throw new Error(`Invalid ${fieldName}: contains dangerous patterns`)
  }
  return value
}

/**
 * Validates a GitHub branch name.
 * Branches can contain slashes (for feature/xxx style branches).
 */
function validateGitHubBranch(value, fieldName) {
  // Branch names: alphanumeric, hyphen, underscore, period, forward slash
  const safePattern = /^[a-zA-Z0-9][\w.\-/]*$/
  if (!safePattern.test(value) || value.length > 250) {
    throw new Error(`Invalid ${fieldName}: contains invalid characters or too long`)
  }
  // Additional check for dangerous patterns
  if (value.includes('..') || value.startsWith('-') || value.endsWith('/')) {
    throw new Error(`Invalid ${fieldName}: contains dangerous patterns`)
  }
  return value
}

async function cloneRepository(credentials) {
  const { githubToken, repoOwner, repoName, branch } = credentials

  // Validate inputs to prevent injection attacks
  // Owner and repo cannot contain slashes; branches can
  const safeRepoOwner = validateGitHubOwnerOrRepo(repoOwner, 'repoOwner')
  const safeRepoName = validateGitHubOwnerOrRepo(repoName, 'repoName')
  const safeBranch = validateGitHubBranch(branch, 'branch')

  log('info', 'Cloning repository', { repoOwner: safeRepoOwner, repoName: safeRepoName, branch: safeBranch })

  await updateStatus({ cloneStatus: 'cloning' })

  if (!existsSync(WORK_DIR)) {
    mkdirSync(WORK_DIR, { recursive: true })
  }

  const repoDir = join(WORK_DIR, safeRepoName)

  // Use HTTPS URL without embedded credentials
  const cloneUrl = `https://github.com/${safeRepoOwner}/${safeRepoName}.git`

  // Create a PERMANENT askpass script in systemd StateDirectory
  // This script reads the token from environment (never stored on disk)
  // and will be used by pty-server for git push operations
  const askpassScript = join(STATE_DIR, 'git-askpass.sh')
  writeFileSync(askpassScript, `#!/bin/sh
# Git askpass script - reads token from environment (never stored on disk)
case "$1" in
  Username*) echo "x-access-token" ;;
  Password*) echo "$GITHUB_PERSONAL_ACCESS_TOKEN" ;;
esac
`, { mode: 0o700 })

  try {
    // Clone using GIT_ASKPASS - credentials are provided via environment,
    // not persisted anywhere on disk
    const gitEnv = {
      ...process.env,
      GIT_ASKPASS: askpassScript,
      GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      GIT_TERMINAL_PROMPT: '0',
    }

    // Use execFileSync with args array to prevent shell injection
    execFileSync('git', [
      'clone',
      '--branch', safeBranch,
      '--single-branch',
      cloneUrl,
      repoDir,
    ], {
      cwd: WORK_DIR,
      stdio: 'pipe',
      timeout: 300000,
      env: gitEnv,
    })

    // Configure git for commits (using execFileSync for consistency)
    execFileSync('git', ['config', 'user.email', 'agent@multitool-workflow.web'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.name', 'Multitool Agent'], { cwd: repoDir })

    // Disable credential helper - we use GIT_ASKPASS instead
    execFileSync('git', ['config', 'credential.helper', ''], { cwd: repoDir })

    log('info', 'Repository cloned successfully')
    await updateStatus({ cloneStatus: 'completed' })

    return repoDir
  }
  catch (error) {
    // Sanitize error message to avoid logging credentials
    const safeErrorMsg = error.message
      .replace(githubToken, '[REDACTED]')
      .replace(/password=\S+/gi, 'password=[REDACTED]')
      .replace(/GITHUB_PERSONAL_ACCESS_TOKEN=\S+/gi, 'GITHUB_PERSONAL_ACCESS_TOKEN=[REDACTED]')
    log('error', 'Failed to clone repository', { error: safeErrorMsg })
    await updateStatus({ cloneStatus: 'failed', cloneError: safeErrorMsg })
    throw new Error(safeErrorMsg)
  }
  // NOTE: Do NOT delete the askpass script - it's needed for git push operations
}

// NOTE: MCP server configuration has been moved to provision.sh (baked into VM image).
// Figma MCP is added dynamically by pty-server.js if figmaApiKey is available.

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

    // Note: MCP server configuration is now baked into VM image (provision.sh)
    // Figma MCP is added dynamically by pty-server.js if figmaApiKey is available

    const repoDir = await cloneRepository(credentials)

    // Write state files to systemd StateDirectory (shared with pty-server)
    // This directory is created by systemd with correct ownership
    // Note: Only non-sensitive metadata is stored, NOT API keys or tokens
    writeFileSync(join(STATE_DIR, 'repo-dir'), repoDir, { mode: 0o600 })
    // Note: needsContinue and other metadata are fetched by pty-server from credentials endpoint
    // No credentials file is written to disk

    // CRITICAL: Transition to running FIRST, before writing done marker
    // This prevents a race condition where the done marker exists but the status
    // update failed, leaving the agent stuck in 'provisioning' state
    const statusUpdated = await updateStatus({ status: 'running' })
    if (!statusUpdated) {
      throw new Error('Failed to update agent status to running')
    }

    // Only write done marker AFTER successful status transition
    // This ensures bootstrap will re-run if status update fails
    writeFileSync(join(STATE_DIR, 'done'), new Date().toISOString(), { mode: 0o600 })

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
