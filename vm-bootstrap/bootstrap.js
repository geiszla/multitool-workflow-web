#!/usr/bin/env node
/**
 * Agent Bootstrap Service
 *
 * This script runs once on initial VM provisioning to:
 * 1. Fetch credentials from Cloud Run using GCE identity token
 * 2. Clone the target repository
 * 3. Configure Claude Code with MCP servers
 * 4. Update agent status to 'running'
 *
 * Security:
 * - Credentials fetched via authenticated endpoint (not stored on disk)
 * - GitHub token used via GIT_ASKPASS (not embedded in URLs)
 * - API keys written to secure files with restricted permissions
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

  const response = await fetch(`${metadataUrl}?audience=${encodeURIComponent(audience)}`, {
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

    // Disable credential helper - we don't want tokens stored on disk
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
      .replace(/GIT_TOKEN=\S+/gi, 'GIT_TOKEN=[REDACTED]')
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

/**
 * Validates that an API key doesn't contain newlines or other dangerous characters.
 */
function validateApiKey(value, fieldName) {
  if (!value || typeof value !== 'string') {
    return null
  }
  // API keys should be alphanumeric with hyphens, underscores, dots
  // Reject newlines or other control characters that could inject env lines
  if (/[\n\r\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid ${fieldName}: contains control characters`)
  }
  return value
}

function configureClaudeCode(credentials) {
  const { claudeApiKey, codexApiKey, figmaApiKey, githubToken } = credentials

  // Validate API keys to prevent environment injection
  const safeClaudeApiKey = validateApiKey(claudeApiKey, 'claudeApiKey')
  const safeCodexApiKey = validateApiKey(codexApiKey, 'codexApiKey')

  // Write API keys to pty-server env file (overwrite, not append, to prevent duplicates)
  let envContent = ''
  if (safeClaudeApiKey) {
    envContent += `ANTHROPIC_API_KEY=${safeClaudeApiKey}\n`
  }
  if (safeCodexApiKey) {
    envContent += `OPENAI_API_KEY=${safeCodexApiKey}\n`
  }
  writeFileSync('/etc/default/pty-server', envContent, { mode: 0o600 })

  // Build MCP config for Claude (goes in ~/.claude.json)
  const mcpServers = {
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      },
    },
    shopify: {
      command: 'npx',
      args: ['-y', '@anthropics/shopify-mcp-server'],
      env: {},
    },
  }

  // Add Figma MCP server only if token is provided
  if (figmaApiKey) {
    mcpServers.figma = {
      command: 'npx',
      args: ['-y', 'figma-mcp-server'],
      env: {
        FIGMA_ACCESS_TOKEN: figmaApiKey,
      },
    }
  }

  const claudeConfig = { mcpServers }

  // Write Claude config to user's home directory
  const claudeConfigPath = join(homedir(), '.claude.json')
  writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2), { mode: 0o600 })

  log('info', 'Claude Code configured with MCP servers', {
    servers: Object.keys(mcpServers),
    hasFigma: !!figmaApiKey,
  })
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

    // Write state files to systemd StateDirectory (shared with pty-server)
    // This directory is created by systemd with correct ownership
    // Use mode 0o600 to protect credentials from other users
    writeFileSync(join(STATE_DIR, 'repo-dir'), repoDir, { mode: 0o600 })
    writeFileSync(join(STATE_DIR, 'credentials'), JSON.stringify({
      needsResume: credentials.needsResume,
      issueNumber: credentials.issueNumber,
      instructions: credentials.instructions,
    }), { mode: 0o600 })

    // Create marker file to indicate bootstrap completed successfully
    // This prevents re-running via systemd ConditionPathExists
    writeFileSync(join(STATE_DIR, 'done'), new Date().toISOString(), { mode: 0o600 })

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
