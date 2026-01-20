import {
  Badge,
  Card,
  Group,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core'
import { IconBrandGithub, IconCircleDot, IconShare } from '@tabler/icons-react'
import { useNavigate } from 'react-router'
import { AgentStatusBadge } from './AgentStatusBadge'

interface AgentCardProps {
  id: string
  title: string
  status: string
  repoOwner: string
  repoName: string
  issueNumber?: number
  issueTitle?: string
  createdAt: string
  ownerGithubLogin?: string
  isOwned?: boolean
}

export function AgentCard({
  id,
  title,
  status,
  repoOwner,
  repoName,
  issueNumber,
  issueTitle,
  createdAt,
  ownerGithubLogin,
  isOwned = true,
}: AgentCardProps) {
  const navigate = useNavigate()

  const formattedDate = new Date(createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <UnstyledButton
      onClick={() => navigate(`/agents/${id}`)}
      style={{ width: '100%' }}
    >
      <Card
        shadow="sm"
        padding="md"
        radius="md"
        withBorder
        style={{
          cursor: 'pointer',
          transition: 'box-shadow 0.2s ease, transform 0.1s ease',
        }}
        styles={{
          root: {
            '&:hover': {
              boxShadow: 'var(--mantine-shadow-md)',
              transform: 'translateY(-1px)',
            },
          },
        }}
      >
        <Group justify="space-between" wrap="nowrap">
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Group gap="sm" wrap="nowrap">
              <AgentStatusBadge status={status} />
              <Text fw={500} truncate style={{ flex: 1 }}>
                {title}
              </Text>
              {!isOwned && ownerGithubLogin && (
                <Badge
                  variant="light"
                  color="grape"
                  size="sm"
                  leftSection={<IconShare size={12} />}
                >
                  Shared by @
                  {ownerGithubLogin}
                </Badge>
              )}
            </Group>

            <Group gap="md" wrap="wrap">
              <Group gap="xs" c="dimmed">
                <IconBrandGithub size={14} />
                <Text size="sm">
                  {repoOwner}
                  /
                  {repoName}
                </Text>
              </Group>

              {issueNumber && (
                <Group gap="xs" c="dimmed">
                  <IconCircleDot size={14} />
                  <Text size="sm" truncate style={{ maxWidth: 200 }}>
                    #
                    {issueNumber}
                    {issueTitle && `: ${issueTitle}`}
                  </Text>
                </Group>
              )}
            </Group>
          </Stack>

          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {formattedDate}
          </Text>
        </Group>
      </Card>
    </UnstyledButton>
  )
}
