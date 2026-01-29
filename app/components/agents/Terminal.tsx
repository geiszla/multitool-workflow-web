/**
 * Terminal Component.
 *
 * Renders an xterm.js terminal that connects to the agent VM via WebSocket.
 * Handles connection state, reconnection, session takeover, and activity tracking.
 */

import type { RefObject } from 'react'
import { Button, Loader, Text } from '@mantine/core'
import { IconAlertCircle, IconPlugConnected, IconRefresh, IconUsers } from '@tabler/icons-react'
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import './Terminal.css'

// Import xterm.js CSS
import '@xterm/xterm/css/xterm.css'

// Reuse TextEncoder instance to avoid per-keystroke allocation
const textEncoder = new TextEncoder()

/**
 * WebSocket message types (must match server protocol).
 */
interface WsMessage {
  type: 'resize' | 'error' | 'exit' | 'connected' | 'session_active' | 'session_taken_over' | 'takeover' | 'vm_reconnecting' | 'restore'
  cols?: number
  rows?: number
  code?: number
  message?: string
  sessionId?: string
  data?: string // Terminal restore data (serialized terminal state)
}

/**
 * Connection state.
 */
type ConnectionState = 'connecting' | 'resuming' | 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'session_conflict'

/**
 * Maximum retry attempts before giving up.
 */
const MAX_RETRY_ATTEMPTS = 10

/**
 * Imperative handle for Terminal component.
 */
export interface TerminalHandle {
  sendInput: (text: string) => void
  isConnected: () => boolean
  disconnect: () => void
}

/**
 * Terminal component props.
 */
interface TerminalProps {
  agentId: string
  ref?: RefObject<TerminalHandle | null>
  /** Current agent status - used to detect suspended state for auto-resume */
  agentStatus?: string
  /** Callback when WebSocket activity occurs (stdin/stdout) - used for inactivity tracking */
  onActivity?: () => void
}

/**
 * Terminal component using xterm.js.
 * Uses ref prop pattern (React 19) to expose imperative handle to parent.
 */
export function Terminal({ ref, agentId, agentStatus, onActivity }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  // Track online handler for cleanup on unmount
  const onlineHandlerRef = useRef<(() => void) | null>(null)
  // TextDecoder for streaming UTF-8 (recreated per connection to avoid state leakage)
  const textDecoderRef = useRef<TextDecoder | null>(null)
  // Track whether reconnect is VM-leg (true) vs browser-WS (false) - used to hide attempt count
  const isVmLegReconnectRef = useRef(false)

  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  // Ref to track connection state for terminal.onData callback (avoids stale closure)
  const connectionStateRef = useRef<ConnectionState>('connecting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  // Expose imperative handle for parent components
  useImperativeHandle(ref, () => ({
    sendInput: (text: string) => {
      // Only send when fully connected (same check as terminal.onData)
      if (wsRef.current?.readyState === WebSocket.OPEN && connectionState === 'connected') {
        // Send stdin as binary packet
        wsRef.current.send(textEncoder.encode(text))
        // Signal activity on programmatic input (e.g., Finish prompt)
        onActivity?.()
      }
    },
    isConnected: () => connectionState === 'connected',
    disconnect: () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Inactivity disconnect')
        wsRef.current = null
      }
    },
  }), [connectionState, onActivity])

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
      scrollback: 10000, // Match server-side virtual terminal scrollback for full restore
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

    // Handle terminal input - send as binary for efficiency
    // Note: We use a ref to track connection state to avoid stale closure issues
    terminal.onData((data) => {
      // Only send stdin when fully connected (not during session_conflict or other states)
      // The connectionState check prevents phantom activity when viewing takeover UI
      if (wsRef.current?.readyState === WebSocket.OPEN && connectionStateRef.current === 'connected') {
        // Send stdin as binary packet
        wsRef.current.send(textEncoder.encode(data))
        // Signal activity on stdin (user typing)
        onActivity?.()
      }
    })

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const message: WsMessage = { type: 'resize', cols, rows }
        wsRef.current.send(JSON.stringify(message))
      }
    })
  }, [onActivity])

  /**
   * Resume a suspended agent.
   * Returns true if resume was successful, false otherwise.
   */
  const resumeAgent = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`/api/agents/${agentId}/resume`, {
        method: 'POST',
      })
      if (response.ok) {
        return true
      }
      const data = await response.json()
      console.warn('Failed to resume agent:', data.error)
      return false
    }
    catch (error) {
      console.error('Error resuming agent:', error)
      return false
    }
  }, [agentId])

  /**
   * Connect to WebSocket.
   * If agent is suspended, attempts to resume first.
   */
  const connect = useCallback(async () => {
    // Don't connect if already open OR connecting
    // This prevents duplicate connections during retry/reconnect scenarios
    if (wsRef.current?.readyState === WebSocket.OPEN
      || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return
    }

    // If agent is suspended or stopped, try to resume/start first
    if (agentStatus === 'suspended' || agentStatus === 'stopped') {
      setConnectionState('resuming')
      setErrorMessage(null)
      setActiveSessionId(null)

      const resumed = await resumeAgent()
      if (!resumed) {
        setConnectionState('error')
        setErrorMessage(`Failed to ${agentStatus === 'stopped' ? 'start' : 'resume'} agent`)
        return
      }
      // Give the VM a moment to come back online
      // Stopped VMs take longer to start than suspended ones
      const waitTime = agentStatus === 'stopped' ? 5000 : 2000
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }

    setConnectionState('connecting')
    setErrorMessage(null)
    setActiveSessionId(null)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/agents/${agentId}/terminal`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    // Set binary type for proper ArrayBuffer handling
    ws.binaryType = 'arraybuffer'

    // Create new TextDecoder for this connection (handles streaming UTF-8)
    // Capture in local variable to avoid race conditions with overlapping WS instances
    const decoder = new TextDecoder('utf-8', { fatal: false })
    textDecoderRef.current = decoder

    ws.onopen = () => {
      // Wait for 'connected' or 'session_active' message to set state
      reconnectAttemptRef.current = 0
    }

    ws.onmessage = (event) => {
      // Guard against stale events from old WS instances
      if (wsRef.current !== ws) {
        return
      }

      // Check if this is a binary message (stdout data)
      if (event.data instanceof ArrayBuffer) {
        // Binary packet = stdout, decode with streaming mode to handle split UTF-8
        const text = decoder.decode(event.data, { stream: true })
        if (xtermRef.current && text) {
          xtermRef.current.write(text)
          // Signal activity on stdout (receiving output)
          onActivity?.()
        }
        // If we're in reconnecting state (VM-leg), stdout arrival means VM is back
        if (connectionStateRef.current === 'reconnecting' && isVmLegReconnectRef.current) {
          setConnectionState('connected')
          isVmLegReconnectRef.current = false
        }
        return
      }

      // JSON packet = control message
      try {
        const msg = JSON.parse(event.data) as WsMessage

        switch (msg.type) {
          case 'connected':
            // Successfully connected (either fresh or after takeover)
            setConnectionState('connected')
            setActiveSessionId(null)
            isVmLegReconnectRef.current = false
            // Send initial resize
            if (xtermRef.current && fitAddonRef.current) {
              fitAddonRef.current.fit()
              const { cols, rows } = xtermRef.current
              const resizeMsg: WsMessage = { type: 'resize', cols, rows }
              ws.send(JSON.stringify(resizeMsg))
            }
            break

          case 'restore':
            // Restore terminal state from server-side virtual terminal
            // This happens after 'connected' message to restore previous output
            if (xtermRef.current && msg.data) {
              // Reset terminal to clear any existing state, then write restored data
              xtermRef.current.reset()
              xtermRef.current.write(msg.data)
            }
            break

          case 'vm_reconnecting':
            // VM leg is reconnecting - show reconnecting UI (input suppressed)
            setConnectionState('reconnecting')
            isVmLegReconnectRef.current = true
            break

          case 'session_active':
            // Another session is active - show takeover UI
            setConnectionState('session_conflict')
            setActiveSessionId(msg.sessionId || null)
            break

          case 'session_taken_over':
            // Our session was taken over by another client
            setConnectionState('error')
            setErrorMessage('Session was taken over by another browser/tab.')
            break

          case 'error':
            setErrorMessage(msg.message || 'Unknown error')
            setConnectionState('error')
            break

          case 'exit':
            xtermRef.current?.write(`\r\n\x1B[33mProcess exited with code ${msg.code}\x1B[0m\r\n`)
            break
        }
      }
      catch (error) {
        console.error('Failed to parse WebSocket message:', error)
      }
    }

    ws.onclose = (event) => {
      // Guard against stale close events - only handle if this is still the active WS
      // or if wsRef was already nulled (normal close path)
      if (wsRef.current !== null && wsRef.current !== ws) {
        return
      }
      wsRef.current = null

      // Flush any buffered partial UTF-8 characters and write to terminal
      // Only cleanup if this decoder is still the active one (prevents stomping new connection's decoder)
      if (textDecoderRef.current === decoder) {
        const flushed = decoder.decode(undefined, { stream: false })
        if (xtermRef.current && flushed) {
          xtermRef.current.write(flushed)
        }
        textDecoderRef.current = null
      }

      // Don't auto-reconnect on:
      // - 1000: Normal close
      // - 1008: Policy violation (used as fallback)
      // - 4001: Unauthorized (auth error)
      // - 4003: Forbidden (authorization error)
      // - 4004: Not found (agent doesn't exist)
      // - 4409: Session taken over (don't auto-reconnect, user needs to decide)
      const noRetryCodes = [1000, 1008, 4001, 4003, 4004, 4409]
      if (noRetryCodes.includes(event.code)) {
        setConnectionState('disconnected')
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
        else if (event.code === 4409) {
          setErrorMessage('Session was taken over by another browser/tab.')
        }
        return
      }

      // Check max retry limit
      const attempt = reconnectAttemptRef.current
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        setConnectionState('error')
        setErrorMessage('Maximum reconnection attempts reached. Please refresh the page.')
        return
      }

      // Optionally pause retries when browser is offline
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setConnectionState('disconnected')
        setErrorMessage('Waiting for network connection...')
        // Wait for online event before retrying (cleanup any existing handler first)
        if (onlineHandlerRef.current) {
          window.removeEventListener('online', onlineHandlerRef.current)
        }
        const handleOnline = () => {
          window.removeEventListener('online', handleOnline)
          onlineHandlerRef.current = null
          connect()
        }
        onlineHandlerRef.current = handleOnline
        window.addEventListener('online', handleOnline)
        return
      }

      setConnectionState('reconnecting')
      setErrorMessage(null)
      isVmLegReconnectRef.current = false // Browser-WS reconnect, not VM-leg

      // Exponential backoff with jitter for reconnection
      const baseDelay = Math.min(1000 * 2 ** attempt, 30000) // Max 30 seconds base
      const jitter = Math.random() * 1000 // 0-1 second random jitter
      const delay = baseDelay + jitter

      console.warn(`WebSocket closed, reconnecting in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`)
      reconnectAttemptRef.current = attempt + 1

      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect()
      }, delay)
    }

    ws.onerror = (error) => {
      // Log error but don't set error state here
      // Error events are always followed by close events, which handle retry
      // This prevents duplicate state transitions
      console.error('WebSocket error:', error)
    }
  }, [agentId, agentStatus, resumeAgent, onActivity])

  /**
   * Disconnect from WebSocket.
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Clean up online handler if set
    if (onlineHandlerRef.current) {
      window.removeEventListener('online', onlineHandlerRef.current)
      onlineHandlerRef.current = null
    }

    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected')
      wsRef.current = null
    }
  }, [])

  /**
   * Request session takeover.
   */
  const requestTakeover = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: WsMessage = { type: 'takeover' }
      wsRef.current.send(JSON.stringify(message))
    }
  }, [])

  /**
   * Keep connectionStateRef in sync with connectionState.
   * This allows terminal.onData callback to access current state without stale closures.
   */
  useEffect(() => {
    connectionStateRef.current = connectionState
  }, [connectionState])

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

  // Note: App-level ping/pong removed. WebSocket protocol-level ping/pong
  // (handled by ws library) is sufficient for connection health checks.
  // Server-side heartbeat tracking is done based on stdin/stdout messages.

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
          {connectionState === 'resuming' && (
            <>
              <Loader color="green" size="lg" />
              <Text className="terminal-overlay-text">
                {agentStatus === 'stopped' ? 'Starting VM...' : 'Resuming VM...'}
              </Text>
              <Text size="sm" c="dimmed" ta="center" mt="xs">
                {agentStatus === 'stopped'
                  ? 'The stopped VM is being started. This may take a minute.'
                  : 'The suspended VM is being resumed. This may take a moment.'}
              </Text>
            </>
          )}

          {connectionState === 'connecting' && (
            <>
              <Loader color="blue" size="lg" />
              <Text className="terminal-overlay-text">Connecting to terminal...</Text>
            </>
          )}

          {connectionState === 'reconnecting' && (
            <>
              <Loader color="orange" size="lg" />
              <Text className="terminal-overlay-text">
                {isVmLegReconnectRef.current
                  ? 'Reconnecting to VM...'
                  : `Reconnecting... (attempt ${reconnectAttemptRef.current}/${MAX_RETRY_ATTEMPTS})`}
              </Text>
              <Text size="sm" c="dimmed" ta="center" mt="xs">
                Connection was interrupted. Attempting to reconnect...
              </Text>
            </>
          )}

          {connectionState === 'session_conflict' && (
            <>
              <IconUsers size={48} color="#ffa94d" />
              <Text className="terminal-overlay-text">
                Another session is active
              </Text>
              <Text size="sm" c="dimmed" ta="center" mt="xs">
                {activeSessionId && `Session: ${activeSessionId.slice(0, 20)}...`}
              </Text>
              <Button
                variant="filled"
                color="orange"
                onClick={requestTakeover}
                mt="md"
              >
                Take Over Session
              </Button>
              <Text size="xs" c="dimmed" ta="center" mt="sm" maw={300}>
                The other session will be disconnected. Any unsaved work in the other browser tab will continue in the background.
              </Text>
            </>
          )}

          {connectionState === 'disconnected' && (
            <>
              <IconPlugConnected size={48} color="#888" />
              <Text className="terminal-overlay-text">Disconnected</Text>
              {errorMessage && (
                <Text size="sm" c="red" ta="center" mt="xs">
                  {errorMessage}
                </Text>
              )}
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
