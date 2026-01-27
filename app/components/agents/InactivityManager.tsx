/**
 * Inactivity Manager Component.
 *
 * Implements inactivity timeout with disconnect at 15 minutes:
 * - Warning at 13 minutes (2 min before disconnect)
 * - Disconnect at 15 minutes (closes WebSocket)
 *
 * Activity is tracked via:
 * - Keyboard/mouse activity on the page
 * - Pauses when tab is hidden
 *
 * Server-side heartbeat tracking is handled by the WebSocket proxy
 * based on actual terminal I/O (stdin/stdout messages).
 */

import type { ReactNode, RefObject } from 'react'
import type { TerminalHandle } from './Terminal'
import {
  Alert,
  Button,
  Group,
  Progress,
  Stack,
  Text,
} from '@mantine/core'
import { IconAlertTriangle, IconPlayerPause } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Inactivity state types.
 * Simplified: only warning and disconnecting states.
 */
type InactivityState
  = | 'active'
    | 'warning' // 2 min before disconnect (at 13 min)
    | 'disconnecting'

/**
 * Timeout constants (in milliseconds).
 */
const DISCONNECT_TIMEOUT = 15 * 60 * 1000 // 15 minutes
const WARNING_TIME = 13 * 60 * 1000 // 13 minutes (2 min before disconnect)

interface InactivityManagerProps {
  /** Agent ID for API calls */
  agentId: string
  /** Whether the agent is currently running */
  isRunning: boolean
  /** Whether the terminal is ready */
  terminalReady: boolean
  /** Reference to the terminal for disconnect */
  terminalRef?: RefObject<TerminalHandle | null>
  /** Callback when user activity is detected */
  onActivity?: () => void
  /** Children (typically the Terminal component) */
  children: ReactNode
}

/**
 * Inactivity Manager component that wraps the terminal.
 *
 * Monitors user activity and disconnects after 15 minutes of inactivity.
 * Server-side reaper will suspend/stop the VM after inactivity threshold.
 */
export function InactivityManager({
  agentId: _agentId, // Reserved for future use
  isRunning,
  terminalReady,
  terminalRef,
  onActivity,
  children,
}: InactivityManagerProps) {
  const [state, setState] = useState<InactivityState>('active')
  const [timeRemaining, setTimeRemaining] = useState<number>(DISCONNECT_TIMEOUT)
  const lastActivityRef = useRef<number>(Date.now())
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isPausedRef = useRef<boolean>(false)

  /**
   * Clears all timers.
   */
  const clearAllTimers = useCallback(() => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current)
      disconnectTimerRef.current = null
    }
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current)
      warningTimerRef.current = null
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
  }, [])

  /**
   * Starts the inactivity timers.
   */
  const startTimers = useCallback(() => {
    clearAllTimers()

    const now = Date.now()
    lastActivityRef.current = now

    // Warning timer (13 minutes)
    warningTimerRef.current = setTimeout(() => {
      setState('warning')
      setTimeRemaining(DISCONNECT_TIMEOUT - WARNING_TIME)

      // Start countdown interval
      countdownIntervalRef.current = setInterval(() => {
        const elapsed = Date.now() - lastActivityRef.current
        const remaining = DISCONNECT_TIMEOUT - elapsed
        setTimeRemaining(Math.max(0, remaining))
      }, 1000)
    }, WARNING_TIME)

    // Disconnect timer (15 minutes)
    disconnectTimerRef.current = setTimeout(() => {
      setState('disconnecting')
      // Disconnect the terminal WebSocket
      if (terminalRef?.current) {
        terminalRef.current.disconnect()
      }
    }, DISCONNECT_TIMEOUT)
  }, [clearAllTimers, terminalRef])

  /**
   * Resets timers on user activity.
   */
  const handleActivity = useCallback(() => {
    if (!isRunning || !terminalReady || isPausedRef.current) {
      return
    }

    lastActivityRef.current = Date.now()
    setState('active')
    setTimeRemaining(DISCONNECT_TIMEOUT)

    // Restart timers
    startTimers()

    // Notify parent
    onActivity?.()
  }, [isRunning, terminalReady, startTimers, onActivity])

  /**
   * Extends session when user dismisses warning.
   */
  const handleExtendSession = useCallback(() => {
    handleActivity()
  }, [handleActivity])

  /**
   * Handles visibility change (pause when tab hidden).
   */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Pause timers when tab is hidden
        isPausedRef.current = true
        clearAllTimers()
      }
      else {
        // Resume timers when tab is visible
        isPausedRef.current = false

        if (isRunning && terminalReady) {
          // Resume with remaining time
          startTimers()
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [clearAllTimers, isRunning, terminalReady, startTimers])

  /**
   * Start timers when component mounts and agent is running.
   */
  useEffect(() => {
    if (isRunning && terminalReady) {
      startTimers()
    }
    else {
      clearAllTimers()
      setState('active')
    }

    return () => {
      clearAllTimers()
    }
  }, [isRunning, terminalReady, startTimers, clearAllTimers])

  /**
   * Set up global activity listeners.
   */
  useEffect(() => {
    if (!isRunning || !terminalReady) {
      return
    }

    const activityEvents = ['keydown', 'mousedown', 'mousemove', 'touchstart', 'scroll']

    // Throttle activity handler to avoid excessive updates
    let lastHandled = 0
    const throttledHandler = () => {
      const now = Date.now()
      if (now - lastHandled > 5000) {
        // Throttle to every 5 seconds
        lastHandled = now
        handleActivity()
      }
    }

    activityEvents.forEach((event) => {
      document.addEventListener(event, throttledHandler, { passive: true })
    })

    return () => {
      activityEvents.forEach((event) => {
        document.removeEventListener(event, throttledHandler)
      })
    }
  }, [isRunning, terminalReady, handleActivity])

  /**
   * Formats remaining time for display.
   */
  const formatTimeRemaining = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  /**
   * Calculates progress percentage.
   */
  const getProgressPercent = (): number => {
    if (state === 'warning') {
      const warningDuration = DISCONNECT_TIMEOUT - WARNING_TIME
      return ((warningDuration - timeRemaining) / warningDuration) * 100
    }
    return 0
  }

  // Show warning banner if in warning state
  const showWarning = state === 'warning'

  return (
    <Stack gap={0} style={{ height: '100%' }}>
      {/* Warning Banner */}
      {showWarning && (
        <Alert
          icon={<IconPlayerPause size={16} />}
          title="Inactivity Warning"
          color="yellow"
          withCloseButton={false}
          mb="xs"
        >
          <Stack gap="xs">
            <Group justify="space-between" align="center">
              <Text size="sm">
                The terminal will be disconnected due to inactivity.
              </Text>
              <Text size="sm" fw={600}>
                {formatTimeRemaining(timeRemaining)}
              </Text>
            </Group>

            <Progress
              value={getProgressPercent()}
              color="yellow"
              size="sm"
              animated
            />

            <Group justify="flex-end">
              <Button
                size="xs"
                variant="light"
                leftSection={<IconAlertTriangle size={14} />}
                onClick={handleExtendSession}
              >
                I'm still here
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {/* Children (Terminal) */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {children}
      </div>
    </Stack>
  )
}

export default InactivityManager
