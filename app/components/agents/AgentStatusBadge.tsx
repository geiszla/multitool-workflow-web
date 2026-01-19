import type { AgentStatus } from '~/models/agent.server'
import { Badge } from '@mantine/core'
import {
  IconCheck,
  IconCircleDot,
  IconLoader,
  IconPlayerPause,
  IconPlayerStop,
  IconX,
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'

interface AgentStatusBadgeProps {
  status: AgentStatus | string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
}

/**
 * Status configuration with colors and icons.
 */
const STATUS_CONFIG: Record<AgentStatus, {
  color: string
  label: string
  icon: React.ReactNode
  pulse?: boolean
}> = {
  pending: {
    color: 'gray',
    label: 'Pending',
    icon: <IconCircleDot size={12} />,
  },
  provisioning: {
    color: 'blue',
    label: 'Provisioning',
    icon: <IconLoader size={12} />,
    pulse: true,
  },
  running: {
    color: 'green',
    label: 'Running',
    icon: <IconCircleDot size={12} />,
    pulse: true,
  },
  suspended: {
    color: 'yellow',
    label: 'Suspended',
    icon: <IconPlayerPause size={12} />,
  },
  stopped: {
    color: 'orange',
    label: 'Stopped',
    icon: <IconPlayerStop size={12} />,
  },
  completed: {
    color: 'teal',
    label: 'Completed',
    icon: <IconCheck size={12} />,
  },
  failed: {
    color: 'red',
    label: 'Failed',
    icon: <IconX size={12} />,
  },
  cancelled: {
    color: 'gray',
    label: 'Cancelled',
    icon: <IconX size={12} />,
  },
}

export function AgentStatusBadge({ status, size = 'sm' }: AgentStatusBadgeProps) {
  const config = STATUS_CONFIG[status as AgentStatus] || {
    color: 'gray',
    label: status,
    icon: <IconCircleDot size={12} />,
  }

  // Pulse animation state
  const [isPulsing, setIsPulsing] = useState(false)

  useEffect(() => {
    if (config.pulse) {
      const interval = setInterval(() => {
        setIsPulsing(p => !p)
      }, 1000)
      return () => clearInterval(interval)
    }
    return undefined
  }, [config.pulse])

  return (
    <Badge
      color={config.color}
      variant="light"
      size={size}
      leftSection={config.icon}
      style={{
        opacity: config.pulse ? (isPulsing ? 1 : 0.7) : 1,
        transition: 'opacity 0.5s ease-in-out',
      }}
    >
      {config.label}
    </Badge>
  )
}
