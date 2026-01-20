#!/usr/bin/env node
/**
 * PTY WebSocket Server
 *
 * This server:
 * 1. Waits for bootstrap to complete
 * 2. Starts a WebSocket server on port 8080
 * 3. Spawns Claude Code in a PTY when a client connects
 * 4. Proxies terminal I/O over WebSocket
 * 5. Reports status changes to Cloud Run
 *
 * Security:
 * - Listens on 0.0.0.0:8080 (internal network only, no external IP)
 * - Single session per PTY (rejects additional connections)
 * - API keys loaded from environment file
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import pty from 'node-pty'
import { WebSocketServer } from 'ws'

const PORT = 8080
const AGENT_ID = process.env.AGENT_ID
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL
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

  const response = await fetch(`${metadataUrl}?audience=${encodeURIComponent(audience)}`, {
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

async function main() {
  log('info', 'PTY server starting')

  await waitForBootstrap()

  const repoDir = readFileSync(join(STATE_DIR, 'repo-dir'), 'utf8').trim()
  let credentialsInfo = {}
  const credentialsFile = join(STATE_DIR, 'credentials')
  if (existsSync(credentialsFile)) {
    credentialsInfo = JSON.parse(readFileSync(credentialsFile, 'utf8'))
  }

  log('info', 'Repo directory', { repoDir })

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
      }
      else {
        updateStatus({ status: 'failed', errorMessage: `Claude Code exited with code ${exitCode}` })
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
      }
      catch (error) {
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
