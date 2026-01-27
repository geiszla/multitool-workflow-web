#!/usr/bin/env node
/**
 * PTY WebSocket Server
 *
 * This server:
 * 1. Waits for bootstrap to complete
 * 2. Fetches credentials from Cloud Run (kept in memory only)
 * 3. Starts a WebSocket server on port 8080
 * 4. Spawns Claude Code in a PTY when a client connects
 * 5. Proxies terminal I/O over WebSocket
 * 6. Reports status changes to Cloud Run
 *
 * Session Management:
 * - Supports session takeover for browser reconnection
 * - When a new client connects while a session is active, sends session_active message
 * - Client can request takeover with { type: "takeover" }
 * - Original session is closed with code 4409 (session taken over)
 *
 * Security:
 * - Listens on 0.0.0.0:8080 (internal network only, no external IP)
 * - API keys fetched at startup and held in memory only (never written to disk)
 * - Credentials injected to PTY process via environment variables
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import pty from 'node-pty'
import { WebSocketServer } from 'ws'

const PORT = 8080
const AGENT_ID = process.env.AGENT_ID
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL
// State directory managed by systemd StateDirectory=agent-bootstrap
const STATE_DIR = '/var/lib/agent-bootstrap'

// Session management
let currentSession = null // { ws, sessionId }
let ptyProcess = null

function log(level, message, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    agentId: AGENT_ID,
    ...data,
  }))
}

function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

// Wait for bootstrap to complete
function waitForBootstrap() {
  const repoDirFile = join(STATE_DIR, 'repo-dir')
  return new Promise((resolve) => {
    const check = () => {
      if (existsSync(repoDirFile)) {
        resolve()
      }
      else {
        setTimeout(check, 1000)
      }
    }
    check()
  })
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

async function updateStatus(updates) {
  try {
    const token = await getIdentityToken()
    const url = `${CLOUD_RUN_URL}/api/agents/${AGENT_ID}/status`

    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    })
  }
  catch (error) {
    log('error', 'Failed to update status', { error: error.message })
  }
}

// In-memory credential storage (never written to disk)
let credentials = null

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

function spawnPtyProcess(repoDir) {
  // Build Claude Code command
  // Note: needsResume is determined from credentials fetched at startup
  const claudeArgs = ['--allowedTools=Bash']
  if (credentials && credentials.needsResume) {
    claudeArgs.push('--resume')
  }

  // Build environment with credentials (held in memory, never written to disk)
  const ptyEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    // Git authentication via GIT_ASKPASS (script reads token from env)
    GIT_ASKPASS: '/var/lib/agent-bootstrap/git-askpass.sh',
    GIT_TERMINAL_PROMPT: '0',
  }

  // Inject credentials via environment variables
  if (credentials) {
    if (credentials.claudeApiKey) {
      ptyEnv.ANTHROPIC_API_KEY = credentials.claudeApiKey
    }
    if (credentials.codexApiKey) {
      ptyEnv.OPENAI_API_KEY = credentials.codexApiKey
    }
    if (credentials.githubToken) {
      ptyEnv.GITHUB_PERSONAL_ACCESS_TOKEN = credentials.githubToken
      // Also set GH_TOKEN and GITHUB_TOKEN for gh CLI compatibility
      ptyEnv.GH_TOKEN = credentials.githubToken
      ptyEnv.GITHUB_TOKEN = credentials.githubToken
    }
  }

  const newPtyProcess = pty.spawn('claude', claudeArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: repoDir,
    env: ptyEnv,
  })

  log('info', 'PTY process started', { pid: newPtyProcess.pid })

  newPtyProcess.onData((data) => {
    if (currentSession && currentSession.ws.readyState === currentSession.ws.OPEN) {
      currentSession.ws.send(JSON.stringify({ type: 'stdout', data }))
    }
  })

  newPtyProcess.onExit(({ exitCode }) => {
    log('info', 'PTY process exited', { exitCode })
    if (currentSession && currentSession.ws.readyState === currentSession.ws.OPEN) {
      currentSession.ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
      currentSession.ws.close()
    }
    ptyProcess = null

    // Update agent status based on exit code
    // Exit code 0 = 'stopped' (normal exit), non-zero = 'failed'
    // Note: The server will stop the VM asynchronously when it receives this status
    if (exitCode === 0) {
      updateStatus({ status: 'stopped' })
    }
    else {
      updateStatus({ status: 'failed', errorMessage: `Claude Code exited with code ${exitCode}` })
    }
  })

  return newPtyProcess
}

function setupWebSocketHandlers(ws, sessionId) {
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
        case 'takeover':
          // This is handled before calling setupWebSocketHandlers
          // Should not reach here, but log if it does
          log('warn', 'Unexpected takeover message after session established')
          break
      }
    }
    catch (error) {
      log('error', 'Failed to parse message', { error: error.message })
    }
  })

  ws.on('close', () => {
    log('info', 'WebSocket connection closed', { sessionId })
    // Clear current session if this was the active one
    if (currentSession && currentSession.sessionId === sessionId) {
      currentSession = null
    }
    // Note: We don't kill the PTY process on disconnect
    // This allows reconnection without losing the session
  })

  ws.on('error', (error) => {
    log('error', 'WebSocket error', { error: error.message, sessionId })
  })
}

/**
 * Updates .claude.json with Figma MCP server if token is available.
 * This is done at runtime since the Figma token needs to be in args.
 *
 * Note: This writes the Figma API key to disk in ~/.claude.json.
 * This is a limitation of the MCP server design which requires tokens in args.
 * Mitigations:
 * - File permissions are restricted to agent user (mode 0o600)
 * - VM has no external IP, limiting attack surface
 * - Disk is auto-deleted when VM is deleted
 */
function updateClaudeConfigForFigma(figmaApiKey) {
  const claudeConfigPath = join(homedir(), '.claude.json')
  try {
    const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'))

    // Add Figma MCP server with token in args
    config.mcpServers = config.mcpServers || {}
    config.mcpServers.figma = {
      command: 'npx',
      args: [
        '-y',
        'figma-developer-mcp',
        '--stdio',
        `--figma-api-key=${figmaApiKey}`,
      ],
    }

    writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    log('info', 'Added Figma MCP server to Claude config')
  }
  catch (error) {
    log('warn', 'Failed to update Claude config for Figma', { error: error.message })
  }
}

async function main() {
  log('info', 'PTY server starting')

  await waitForBootstrap()

  const repoDir = readFileSync(join(STATE_DIR, 'repo-dir'), 'utf8').trim()
  log('info', 'Repo directory', { repoDir })

  // Fetch credentials from Cloud Run and hold in memory
  // This is the only time credentials are fetched - they are never written to disk
  // FAIL-FAST: If credentials cannot be fetched, do NOT start server or report ready
  try {
    credentials = await fetchCredentials()

    // Validate required credentials are present
    if (!credentials.claudeApiKey) {
      throw new Error('Missing required Claude API key')
    }

    log('info', 'Credentials fetched successfully', {
      hasGithub: !!credentials.githubToken,
      hasClaude: !!credentials.claudeApiKey,
      hasCodex: !!credentials.codexApiKey,
      hasFigma: !!credentials.figmaApiKey,
    })

    // If Figma token is available, update .claude.json with Figma MCP
    if (credentials.figmaApiKey) {
      updateClaudeConfigForFigma(credentials.figmaApiKey)
    }
  }
  catch (error) {
    // Log error and exit - do NOT start server or report ready
    log('error', 'Failed to fetch credentials', { error: error.message })
    await updateStatus({
      status: 'failed',
      errorMessage: `PTY server failed to fetch credentials: ${error.message}`,
    })
    process.exit(1)
  }

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'healthy', agentId: AGENT_ID }))
    }
    else {
      res.writeHead(404)
      res.end()
    }
  })

  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    const newSessionId = generateSessionId()
    log('info', 'WebSocket connection request', { newSessionId })

    // If there's an existing session, notify the new client and wait for takeover
    if (currentSession && currentSession.ws.readyState === currentSession.ws.OPEN) {
      log('info', 'Existing session active, sending session_active message', {
        existingSessionId: currentSession.sessionId,
        newSessionId,
      })

      // Send session_active message to new client
      ws.send(JSON.stringify({
        type: 'session_active',
        sessionId: currentSession.sessionId,
        message: 'Another session is currently active. Send { type: "takeover" } to take over.',
      }))

      // Set up temporary handler for takeover
      const takeoverHandler = (message) => {
        try {
          const msg = JSON.parse(message.toString())
          if (msg.type === 'takeover') {
            log('info', 'Takeover requested', {
              oldSessionId: currentSession.sessionId,
              newSessionId,
            })

            // Close old session with takeover code
            if (currentSession.ws.readyState === currentSession.ws.OPEN) {
              currentSession.ws.send(JSON.stringify({
                type: 'session_taken_over',
                message: 'Your session was taken over by another client.',
              }))
              currentSession.ws.close(4409, 'Session taken over')
            }

            // Remove temporary handler
            ws.removeListener('message', takeoverHandler)

            // Establish new session
            currentSession = { ws, sessionId: newSessionId }
            setupWebSocketHandlers(ws, newSessionId)

            // Send connected confirmation
            ws.send(JSON.stringify({ type: 'connected', sessionId: newSessionId }))

            log('info', 'Takeover complete', { sessionId: newSessionId })
          }
        }
        catch (error) {
          log('error', 'Error handling takeover message', { error: error.message })
        }
      }

      ws.on('message', takeoverHandler)

      // If client disconnects before takeover, cleanup
      ws.on('close', () => {
        ws.removeListener('message', takeoverHandler)
      })

      return
    }

    // No existing session - establish new one
    log('info', 'WebSocket connection established', { sessionId: newSessionId })
    currentSession = { ws, sessionId: newSessionId }

    // Spawn PTY process if not already running
    if (!ptyProcess) {
      ptyProcess = spawnPtyProcess(repoDir)
    }

    // Set up message handlers
    setupWebSocketHandlers(ws, newSessionId)

    // Send connected confirmation
    ws.send(JSON.stringify({ type: 'connected', sessionId: newSessionId }))
  })

  server.listen(PORT, '0.0.0.0', async () => {
    log('info', `PTY server listening on port ${PORT}`)
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
