/**
 * Custom Server Entry Point.
 *
 * This server extends the default React Router serve with WebSocket support
 * for the terminal proxy endpoint.
 *
 * WebSocket connections to /api/agents/:id/terminal are handled here,
 * while all other requests are handled by React Router.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequestListener } from '@react-router/node'
import sirv from 'sirv'
import { WebSocketServer } from 'ws'
import { setupProxyConnection } from '~/services/websocket-proxy.server'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Import the built React Router app
const requestHandler = createRequestListener({
  // @ts-expect-error - Build output is dynamic
  build: () => import('./build/server/index.js'),
})

// Static file serving for production assets from build/client
const clientDir = path.join(__dirname, 'client')

// Hashed assets with immutable caching (1 year)
const assetsHandler = sirv(path.join(clientDir, 'assets'), {
  maxAge: 31536000,
  immutable: true,
  gzip: true,
  brotli: true,
})

// Other client files with shorter cache (1 hour)
const clientHandler = sirv(clientDir, {
  maxAge: 3600,
  gzip: true,
  brotli: true,
})

const PORT = Number(process.env.PORT) || 3000
const isProd = process.env.NODE_ENV === 'production'
const appOrigin = process.env.APP_URL || 'http://localhost:3000'

/**
 * Generates a cryptographic nonce for CSP.
 */
function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64')
}

/**
 * Applies security headers to the response.
 */
function applySecurityHeaders(res: ServerResponse, nonce: string): void {
  const cspDirectives = [
    'default-src \'self\'',
    'base-uri \'self\'',
    'frame-ancestors \'none\'',
    'form-action \'self\'',
    'object-src \'none\'',
    `script-src 'self' 'nonce-${nonce}'${isProd ? '' : ' \'unsafe-eval\''}`, // unsafe-eval for Vite HMR
    'style-src \'self\' \'unsafe-inline\'', // Mantine CSS-in-JS requires this
    'img-src \'self\' data: https://avatars.githubusercontent.com',
    `connect-src 'self' ${appOrigin} ${appOrigin.replace('https://', 'wss://').replace('http://', 'ws://')} https://*.firebaseio.com wss://*.firebaseio.com https://*.googleapis.com`,
    `report-uri ${appOrigin}/api/internal/csp-report`,
  ].join('; ')

  // Report-Only mode for testing (switch to enforcing after validation)
  res.setHeader('Content-Security-Policy-Report-Only', cspDirectives)

  // Other security headers
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')

  // OAuth popups need allow-popups for GitHub auth flow
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')

  // HSTS only in production
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

// Create HTTP server
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Generate nonce for this request
  const nonce = generateNonce()

  // Apply security headers
  applySecurityHeaders(res, nonce)

  // Store nonce for potential use by React Router (if needed in future)
  // @ts-expect-error - Adding custom property for nonce
  res.locals = { cspNonce: nonce }

  const url = req.url || '/'

  // Serve hashed assets from /assets/* with immutable caching
  if (url.startsWith('/assets/')) {
    req.url = url.slice(7)
    assetsHandler(req, res, () => {
      res.statusCode = 404
      res.end('Not Found')
    })
    return
  }

  // Try other static files, fall through to React Router if not found
  clientHandler(req, res, () => {
    try {
      requestHandler(req, res)
    }
    catch (error) {
      console.error('Request handler error:', error)
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  })
})

// Create WebSocket server attached to the HTTP server
const wss = new WebSocketServer({ noServer: true })

// Handle WebSocket upgrades
server.on('upgrade', async (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname

  // Check if this is a terminal WebSocket request
  const terminalMatch = pathname?.match(/^\/api\/agents\/([^/]+)\/terminal$/)

  if (terminalMatch) {
    const agentId = terminalMatch[1]

    wss.handleUpgrade(request, socket, head, (ws) => {
      // Use IIFE + catch to handle async errors properly
      // This prevents unhandled promise rejections from crashing the server
      (async () => {
        try {
          const result = await setupProxyConnection(ws, request, agentId)

          if (!result.success) {
            // Send error message and close
            ws.send(JSON.stringify({
              type: 'error',
              message: result.error,
            }))
            ws.close(result.errorCode || 1008, result.error)
          }
        }
        catch (error) {
          console.error('WebSocket setup error:', error)
          try {
            ws.close(1011, 'Internal server error')
          }
          catch {
            // Ignore close errors - socket may already be closed
          }
        }
      })()
    })
  }
  else {
    // Not a WebSocket endpoint we handle
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  }
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${PORT}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.log('SIGTERM received, shutting down gracefully')

  // Close WebSocket server and all connections
  wss.close(() => {
    // eslint-disable-next-line no-console
    console.log('WebSocket server closed')
  })

  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('HTTP server closed')
    process.exit(0)
  })
})
