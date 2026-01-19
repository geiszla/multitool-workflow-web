import type { ReactNode } from 'react'
import {
  Badge,
  Card,
  Group,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core'
import { IconCheck, IconX } from '@tabler/icons-react'

interface ExternalToolCardProps {
  /** Tool name */
  title: string
  /** Tool description */
  description: string
  /** Icon component */
  icon: ReactNode
  /** Whether the tool is configured */
  isConfigured: boolean
  /** Children (usually ApiKeyInput or GitHub status) */
  children: ReactNode
}

export function ExternalToolCard({
  title,
  description,
  icon,
  isConfigured,
  children,
}: ExternalToolCardProps) {
  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon size="lg" variant="light" radius="md">
              {icon}
            </ThemeIcon>
            <div>
              <Text fw={500}>{title}</Text>
              <Text size="sm" c="dimmed">
                {description}
              </Text>
            </div>
          </Group>
          <Badge
            color={isConfigured ? 'green' : 'gray'}
            variant="light"
            leftSection={
              isConfigured
                ? <IconCheck size={12} />
                : <IconX size={12} />
            }
          >
            {isConfigured ? 'Configured' : 'Not configured'}
          </Badge>
        </Group>

        {children}
      </Stack>
    </Card>
  )
}
