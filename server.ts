/**
 * Custom Server Entry Point.
 *
 * This server extends the default React Router serve with WebSocket support
 * for the terminal proxy endpoint.
 *
 * WebSocket connections to /api/agents/:id/terminal are handled here,
 * while all other requests are handled by React Router.
 */

import { createServer } from 'node:http'
import { createRequestListener } from '@react-router/node'
import { WebSocketServer } from 'ws'
import { setupProxyConnection } from '~/services/websocket-proxy.server'

// Import the built React Router app
const requestHandler = createRequestListener({
  // @ts-expect-error - Build output is dynamic
  build: () => import('./build/server/index.js'),
})

const PORT = Number(process.env.PORT) || 3000

// Create HTTP server
const server = createServer(async (req, res) => {
  try {
    // Handle HTTP requests through React Router
    await requestHandler(req, res)
  }
  catch (error) {
    console.error('Request handler error:', error)
    res.statusCode = 500
    res.end('Internal Server Error')
  }
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

    wss.handleUpgrade(request, socket, head, async (ws) => {
      const result = await setupProxyConnection(ws, request, agentId)

      if (!result.success) {
        // Send error message and close
        ws.send(JSON.stringify({
          type: 'error',
          message: result.error,
        }))
        ws.close(result.errorCode || 1008, result.error)
      }
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
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('Server closed')
    process.exit(0)
  })
})
