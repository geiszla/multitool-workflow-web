/**
 * Terminal Component.
 *
 * Renders an xterm.js terminal that connects to the agent VM via WebSocket.
 * Handles connection state, reconnection, and activity tracking.
 */

import { Loader, Text } from '@mantine/core'
import { IconAlertCircle, IconPlugConnected, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import './Terminal.css'

// Import xterm.js CSS
import '@xterm/xterm/css/xterm.css'

/**
 * WebSocket message types (must match server protocol).
 */
interface WsMessage {
  type: 'stdin' | 'stdout' | 'resize' | 'ping' | 'pong' | 'error' | 'exit'
  data?: string
  cols?: number
  rows?: number
  code?: number
  message?: string
}

/**
 * Connection state.
 */
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

/**
 * Terminal component props.
 */
interface TerminalProps {
  agentId: string
}

/**
 * Imperative handle for Terminal component.
 */
export interface TerminalHandle {
  sendInput: (text: string) => void
  isConnected: () => boolean
}

/**
 * Terminal component using xterm.js.
 */
export function Terminal({ ref, agentId }: TerminalProps & { ref?: React.RefObject<TerminalHandle | null> }) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)

  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Expose imperative handle for parent components
  useImperativeHandle(ref, () => ({
    sendInput: (text: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const message: WsMessage = { type: 'stdin', data: text }
        wsRef.current.send(JSON.stringify(message))
      }
    },
    isConnected: () => connectionState === 'connected',
  }), [connectionState])

  /**
   * Initialize xterm.js terminal.
   */
  const initTerminal = useCallback(async () => {
    if (!terminalRef.current || xtermRef.current) {
      return
    }

    // Dynamic imports for xterm.js (client-only)
    const { Terminal: XTerm } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    const { WebLinksAddon } = await import('@xterm/addon-web-links')

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        cursorAccent: '#000000',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())

    terminal.open(terminalRef.current)
    fitAddon.fit()

    xtermRef.current = terminal
    fitAddonRef.current = fitAddon

    // Handle terminal input
    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const message: WsMessage = { type: 'stdin', data }
        wsRef.current.send(JSON.stringify(message))
      }
    })

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const message: WsMessage = { type: 'resize', cols, rows }
        wsRef.current.send(JSON.stringify(message))
      }
    })
  }, [])

  /**
   * Connect to WebSocket.
   */
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return
    }

    setConnectionState('connecting')
    setErrorMessage(null)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/agents/${agentId}/terminal`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnectionState('connected')
      reconnectAttemptRef.current = 0

      // Send initial resize
      if (xtermRef.current && fitAddonRef.current) {
        fitAddonRef.current.fit()
        const { cols, rows } = xtermRef.current
        const message: WsMessage = { type: 'resize', cols, rows }
        ws.send(JSON.stringify(message))
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage

        switch (msg.type) {
          case 'stdout':
            if (msg.data && xtermRef.current) {
              xtermRef.current.write(msg.data)
            }
            break

          case 'error':
            setErrorMessage(msg.message || 'Unknown error')
            setConnectionState('error')
            break

          case 'exit':
            xtermRef.current?.write(`\r\n\x1B[33mProcess exited with code ${msg.code}\x1B[0m\r\n`)
            break

          case 'pong':
            // Health check response
            break
        }
      }
      catch (error) {
        console.error('Failed to parse WebSocket message:', error)
      }
    }

    ws.onclose = (event) => {
      setConnectionState('disconnected')
      wsRef.current = null

      // Don't auto-reconnect on:
      // - 1000: Normal close
      // - 1008: Policy violation (used as fallback)
      // - 4001: Unauthorized (auth error)
      // - 4003: Forbidden (authorization error)
      // - 4004: Not found (agent doesn't exist)
      const noRetryCodes = [1000, 1008, 4001, 4003, 4004]
      if (noRetryCodes.includes(event.code)) {
        // Set specific error message for auth-related codes
        if (event.code === 4001) {
          setErrorMessage('Authentication failed. Please refresh the page to log in again.')
        }
        else if (event.code === 4003) {
          setErrorMessage('You are not authorized to access this agent.')
        }
        else if (event.code === 4004) {
          setErrorMessage('Agent not found.')
        }
        return
      }

      // Exponential backoff for reconnection
      const attempt = reconnectAttemptRef.current
      const delay = Math.min(1000 * 2 ** attempt, 30000) // Max 30 seconds

      console.warn(`WebSocket closed, reconnecting in ${delay}ms (attempt ${attempt + 1})`)
      reconnectAttemptRef.current = attempt + 1

      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect()
      }, delay)
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      setErrorMessage('Connection error')
      setConnectionState('error')
    }
  }, [agentId])

  /**
   * Disconnect from WebSocket.
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected')
      wsRef.current = null
    }
  }, [])

  /**
   * Handle window resize.
   */
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit()
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  /**
   * Ping health check (every 30 seconds).
   */
  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)

    return () => clearInterval(pingInterval)
  }, [])

  /**
   * Initialize terminal and connect on mount.
   */
  useEffect(() => {
    initTerminal().then(() => {
      connect()
    })

    return () => {
      disconnect()

      if (xtermRef.current) {
        xtermRef.current.dispose()
        xtermRef.current = null
      }
    }
  }, [initTerminal, connect, disconnect])

  /**
   * Manual reconnect handler.
   */
  const handleReconnect = useCallback(() => {
    reconnectAttemptRef.current = 0
    connect()
  }, [connect])

  return (
    <div className="terminal-container" style={{ position: 'relative' }}>
      <div ref={terminalRef} className="terminal-wrapper" />

      {connectionState !== 'connected' && (
        <div className="terminal-overlay">
          {connectionState === 'connecting' && (
            <>
              <Loader color="blue" size="lg" />
              <Text className="terminal-overlay-text">Connecting to terminal...</Text>
            </>
          )}

          {connectionState === 'disconnected' && (
            <>
              <IconPlugConnected size={48} color="#888" />
              <Text className="terminal-overlay-text">Disconnected</Text>
              <button
                type="button"
                className="terminal-reconnect-button"
                onClick={handleReconnect}
              >
                <IconRefresh size={16} style={{ marginRight: 8, verticalAlign: 'middle' }} />
                Reconnect
              </button>
            </>
          )}

          {connectionState === 'error' && (
            <>
              <IconAlertCircle size={48} color="#f08080" />
              <Text className="terminal-overlay-text terminal-overlay-error">
                {errorMessage || 'Connection error'}
              </Text>
              <button
                type="button"
                className="terminal-reconnect-button"
                onClick={handleReconnect}
              >
                <IconRefresh size={16} style={{ marginRight: 8, verticalAlign: 'middle' }} />
                Try Again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
