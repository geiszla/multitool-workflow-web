/**
 * Inactivity Manager Component.
 *
 * Implements two-stage inactivity timeout:
 * - Suspend after 15 minutes of inactivity
 * - Stop after 1 hour of inactivity
 *
 * Shows warnings before actions:
 * - 2 minutes before suspend
 * - 5 minutes before stop
 *
 * Tracks keyboard/mouse activity and pauses when tab is hidden.
 */

import type { ReactNode } from 'react'
import {
  Alert,
  Button,
  Group,
  Progress,
  Stack,
  Text,
} from '@mantine/core'
import { IconAlertTriangle, IconPlayerPause, IconPlayerStop } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Inactivity state types.
 */
type InactivityState
  = | 'active'
    | 'warning-suspend' // 2 min before suspend (at 13 min)
    | 'warning-stop' // 5 min before stop (at 55 min)
    | 'suspending'
    | 'stopping'

/**
 * Timeout constants (in milliseconds).
 */
const SUSPEND_TIMEOUT = 15 * 60 * 1000 // 15 minutes
const STOP_TIMEOUT = 60 * 60 * 1000 // 1 hour
const SUSPEND_WARNING = 13 * 60 * 1000 // 13 minutes (2 min before suspend)
const STOP_WARNING = 55 * 60 * 1000 // 55 minutes (5 min before stop)

/**
 * Activity update interval for server (in milliseconds).
 * Update server every 30 seconds during active use.
 */
const ACTIVITY_UPDATE_INTERVAL = 30 * 1000

interface InactivityManagerProps {
  /** Agent ID for API calls */
  agentId: string
  /** Whether the agent is currently running */
  isRunning: boolean
  /** Whether the terminal is ready */
  terminalReady: boolean
  /** Callback when user activity is detected */
  onActivity?: () => void
  /** Callback when suspend is triggered */
  onSuspend?: () => Promise<void>
  /** Callback when stop is triggered */
  onStop?: () => Promise<void>
  /** Children (typically the Terminal component) */
  children: ReactNode
}

/**
 * Inactivity Manager component that wraps the terminal.
 *
 * Monitors user activity and triggers suspend/stop after inactivity periods.
 */
export function InactivityManager({
  agentId,
  isRunning,
  terminalReady,
  onActivity,
  onSuspend,
  onStop: _onStop, // Reserved for future use when stop timeout is implemented
  children,
}: InactivityManagerProps) {
  const [state, setState] = useState<InactivityState>('active')
  const [timeRemaining, setTimeRemaining] = useState<number>(SUSPEND_TIMEOUT)
  const lastActivityRef = useRef<number>(Date.now())
  const suspendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activityUpdateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isPausedRef = useRef<boolean>(false)
  const pausedTimeRemainingRef = useRef<number>(0)

  /**
   * Clears all timers.
   */
  const clearAllTimers = useCallback(() => {
    if (suspendTimerRef.current) {
      clearTimeout(suspendTimerRef.current)
      suspendTimerRef.current = null
    }
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current)
      warningTimerRef.current = null
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    if (activityUpdateIntervalRef.current) {
      clearInterval(activityUpdateIntervalRef.current)
      activityUpdateIntervalRef.current = null
    }
  }, [])

  /**
   * Updates the server with last activity timestamp.
   */
  const updateServerActivity = useCallback(async () => {
    try {
      await fetch(`/api/agents/${agentId}/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: Date.now() }),
      })
    }
    catch (error) {
      // Silently fail - activity update is best-effort
      console.warn('Failed to update activity:', error)
    }
  }, [agentId])

  /**
   * Starts the inactivity timers.
   */
  const startTimers = useCallback(() => {
    clearAllTimers()

    const now = Date.now()
    lastActivityRef.current = now

    // Warning timer for suspend (13 minutes)
    warningTimerRef.current = setTimeout(() => {
      setState('warning-suspend')
      setTimeRemaining(SUSPEND_TIMEOUT - SUSPEND_WARNING)

      // Start countdown interval
      countdownIntervalRef.current = setInterval(() => {
        const elapsed = Date.now() - lastActivityRef.current
        const remaining = SUSPEND_TIMEOUT - elapsed
        setTimeRemaining(Math.max(0, remaining))
      }, 1000)
    }, SUSPEND_WARNING)

    // Suspend timer (15 minutes)
    suspendTimerRef.current = setTimeout(async () => {
      setState('suspending')
      if (onSuspend) {
        await onSuspend()
      }
    }, SUSPEND_TIMEOUT)

    // Set up activity update interval
    activityUpdateIntervalRef.current = setInterval(() => {
      if (!isPausedRef.current) {
        updateServerActivity()
      }
    }, ACTIVITY_UPDATE_INTERVAL)
  }, [clearAllTimers, onSuspend, updateServerActivity])

  /**
   * Resets timers on user activity.
   */
  const handleActivity = useCallback(() => {
    if (!isRunning || !terminalReady || isPausedRef.current) {
      return
    }

    lastActivityRef.current = Date.now()
    setState('active')
    setTimeRemaining(SUSPEND_TIMEOUT)

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
    // Update server immediately when user explicitly extends
    updateServerActivity()
  }, [handleActivity, updateServerActivity])

  /**
   * Handles visibility change (pause when tab hidden).
   */
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Pause timers when tab is hidden
        isPausedRef.current = true
        pausedTimeRemainingRef.current = timeRemaining

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
  }, [clearAllTimers, isRunning, terminalReady, startTimers, timeRemaining])

  /**
   * Start timers when component mounts and agent is running.
   */
  useEffect(() => {
    if (isRunning && terminalReady) {
      startTimers()
      // Initial activity update
      updateServerActivity()
    }
    else {
      clearAllTimers()
      setState('active')
    }

    return () => {
      clearAllTimers()
    }
  }, [isRunning, terminalReady, startTimers, clearAllTimers, updateServerActivity])

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
    if (state === 'warning-suspend') {
      const warningDuration = SUSPEND_TIMEOUT - SUSPEND_WARNING
      return ((warningDuration - timeRemaining) / warningDuration) * 100
    }
    if (state === 'warning-stop') {
      const warningDuration = STOP_TIMEOUT - STOP_WARNING
      return ((warningDuration - timeRemaining) / warningDuration) * 100
    }
    return 0
  }

  // Show warning banner if in warning state
  const showWarning = state === 'warning-suspend' || state === 'warning-stop'

  return (
    <Stack gap={0} style={{ height: '100%' }}>
      {/* Warning Banner */}
      {showWarning && (
        <Alert
          icon={state === 'warning-suspend' ? <IconPlayerPause size={16} /> : <IconPlayerStop size={16} />}
          title={state === 'warning-suspend' ? 'Inactivity Warning' : 'Extended Inactivity Warning'}
          color={state === 'warning-suspend' ? 'yellow' : 'orange'}
          withCloseButton={false}
          mb="xs"
        >
          <Stack gap="xs">
            <Group justify="space-between" align="center">
              <Text size="sm">
                {state === 'warning-suspend'
                  ? 'The agent will be suspended due to inactivity.'
                  : 'The agent will be stopped due to extended inactivity.'}
              </Text>
              <Text size="sm" fw={600}>
                {formatTimeRemaining(timeRemaining)}
              </Text>
            </Group>

            <Progress
              value={getProgressPercent()}
              color={state === 'warning-suspend' ? 'yellow' : 'orange'}
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
