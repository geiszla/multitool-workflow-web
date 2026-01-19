import type { Route } from './+types/_app.agents.$id'
import type { AgentStatus } from '~/models/agent.server'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconArrowLeft,
  IconBrandGithub,
  IconGitBranch,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { redirect, useFetcher, useLoaderData, useNavigate } from 'react-router'
import { AgentStatusBadge } from '~/components/agents/AgentStatusBadge'
import {
  getAgentForUser,
  getValidTransitions,
  isActiveStatus,
  updateAgentStatus,
} from '~/models/agent.server'
import { requireUser } from '~/services/session.server'

export function meta({ data }: Route.MetaArgs) {
  const title = data?.agent?.title || 'Agent'
  return [
    { title: `${title} - Multitool Workflow` },
    { name: 'description', content: `View agent: ${title}` },
  ]
}

interface LoaderData {
  agent: {
    id: string
    title: string
    status: AgentStatus
    repoOwner: string
    repoName: string
    branch: string
    issueNumber?: number
    issueTitle?: string
    instructions?: string
    errorMessage?: string
    createdAt: string
    startedAt?: string
    suspendedAt?: string
    stoppedAt?: string
    completedAt?: string
    instanceName?: string
    instanceZone?: string
    instanceStatus?: string
  }
  validActions: AgentStatus[]
  isActive: boolean
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<LoaderData> {
  const user = await requireUser(request)
  const agentId = params.id

  if (!agentId) {
    throw redirect('/agents')
  }

  try {
    const agent = await getAgentForUser(agentId, user.id)

    return {
      agent: {
        id: agent.id,
        title: agent.title,
        status: agent.status,
        repoOwner: agent.repoOwner,
        repoName: agent.repoName,
        branch: agent.branch,
        issueNumber: agent.issueNumber,
        issueTitle: agent.issueTitle,
        instructions: agent.instructions,
        errorMessage: agent.errorMessage,
        createdAt: agent.createdAt.toDate().toISOString(),
        startedAt: agent.startedAt?.toDate().toISOString(),
        suspendedAt: agent.suspendedAt?.toDate().toISOString(),
        stoppedAt: agent.stoppedAt?.toDate().toISOString(),
        completedAt: agent.completedAt?.toDate().toISOString(),
        instanceName: agent.instanceName,
        instanceZone: agent.instanceZone,
        instanceStatus: agent.instanceStatus,
      },
      validActions: getValidTransitions(agent.status),
      isActive: isActiveStatus(agent.status),
    }
  }
  catch (error) {
    const statusError = error as Error & { status?: number }
    if (statusError.status === 404 || statusError.status === 403) {
      throw redirect('/agents')
    }
    throw error
  }
}

interface ActionData {
  success?: boolean
  error?: string
}

export async function action({ request, params }: Route.ActionArgs): Promise<ActionData> {
  const user = await requireUser(request)
  const agentId = params.id
  const formData = await request.formData()
  const intent = formData.get('intent') as string

  if (!agentId) {
    return { error: 'Agent ID is required' }
  }

  try {
    const agent = await getAgentForUser(agentId, user.id)
    const validTransitions = getValidTransitions(agent.status)

    // Map intent to target status
    const statusMap: Record<string, AgentStatus> = {
      cancel: 'cancelled',
      suspend: 'suspended',
      stop: 'stopped',
      resume: 'running',
      start: 'running',
    }

    const targetStatus = statusMap[intent]

    if (!targetStatus) {
      return { error: 'Invalid action' }
    }

    if (!validTransitions.includes(targetStatus)) {
      return { error: `Cannot ${intent} agent in ${agent.status} status` }
    }

    // TODO: Trigger actual GCE operations for suspend/stop/resume/start
    await updateAgentStatus(agentId, agent.status, targetStatus)

    return { success: true }
  }
  catch (error) {
    console.error('Agent action error:', error instanceof Error ? error.message : 'Unknown error')
    return { error: 'Failed to perform action. Please try again.' }
  }
}

export default function AgentView() {
  const { agent, validActions, isActive: _isActive } = useLoaderData<LoaderData>()
  const navigate = useNavigate()
  const fetcher = useFetcher<ActionData>()

  const isLoading = fetcher.state !== 'idle'

  const formatDate = (isoString?: string) => {
    if (!isoString)
      return null
    return new Date(isoString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const handleAction = (intent: string) => {
    fetcher.submit({ intent }, { method: 'post' })
  }

  // Determine which action buttons to show
  const canCancel = validActions.includes('cancelled')
  const canSuspend = validActions.includes('suspended')
  const canStop = validActions.includes('stopped')
  const canResume = agent.status === 'suspended' && validActions.includes('running')
  const canStart = agent.status === 'stopped' && validActions.includes('running')
  const canDelete = ['completed', 'failed', 'cancelled', 'stopped'].includes(agent.status)
  const canRetry = agent.status === 'failed'

  return (
    <Stack gap="lg">
      {/* Header with back button */}
      <Group justify="space-between" align="flex-start">
        <Group>
          <Button
            variant="subtle"
            leftSection={<IconArrowLeft size={16} />}
            onClick={() => navigate('/agents')}
          >
            Back to Agents
          </Button>
        </Group>
      </Group>

      {/* Error alert */}
      {fetcher.data?.error && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          title="Error"
          color="red"
          withCloseButton
        >
          {fetcher.data.error}
        </Alert>
      )}

      {/* Agent header */}
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Group gap="md" mb="xs">
                <Title order={2}>{agent.title}</Title>
                <AgentStatusBadge status={agent.status} size="lg" />
              </Group>

              <Group gap="md">
                <Group gap="xs">
                  <IconBrandGithub size={16} color="var(--mantine-color-dimmed)" />
                  <Anchor
                    href={`https://github.com/${agent.repoOwner}/${agent.repoName}`}
                    target="_blank"
                    c="dimmed"
                    size="sm"
                  >
                    {agent.repoOwner}
                    /
                    {agent.repoName}
                  </Anchor>
                </Group>

                <Group gap="xs">
                  <IconGitBranch size={16} color="var(--mantine-color-dimmed)" />
                  <Text size="sm" c="dimmed">
                    {agent.branch}
                  </Text>
                </Group>

                {agent.issueNumber && (
                  <Anchor
                    href={`https://github.com/${agent.repoOwner}/${agent.repoName}/issues/${agent.issueNumber}`}
                    target="_blank"
                    c="dimmed"
                    size="sm"
                  >
                    #
                    {agent.issueNumber}
                    {agent.issueTitle && `: ${agent.issueTitle}`}
                  </Anchor>
                )}
              </Group>
            </div>

            {/* Action buttons */}
            <Group>
              {canCancel && (
                <Button
                  variant="light"
                  color="gray"
                  leftSection={<IconX size={16} />}
                  onClick={() => handleAction('cancel')}
                  loading={isLoading}
                >
                  Cancel
                </Button>
              )}

              {canSuspend && (
                <Button
                  variant="light"
                  color="yellow"
                  leftSection={<IconPlayerPause size={16} />}
                  onClick={() => handleAction('suspend')}
                  loading={isLoading}
                >
                  Suspend
                </Button>
              )}

              {canResume && (
                <Button
                  variant="light"
                  color="green"
                  leftSection={<IconPlayerPlay size={16} />}
                  onClick={() => handleAction('resume')}
                  loading={isLoading}
                >
                  Resume
                </Button>
              )}

              {canStop && (
                <Button
                  variant="light"
                  color="orange"
                  leftSection={<IconPlayerStop size={16} />}
                  onClick={() => handleAction('stop')}
                  loading={isLoading}
                >
                  Stop
                </Button>
              )}

              {canStart && (
                <Button
                  variant="light"
                  color="green"
                  leftSection={<IconPlayerPlay size={16} />}
                  onClick={() => handleAction('start')}
                  loading={isLoading}
                >
                  Start
                </Button>
              )}

              {canRetry && (
                <Button
                  variant="light"
                  color="blue"
                  leftSection={<IconRefresh size={16} />}
                  onClick={() => navigate('/agents')} // TODO: Implement retry
                  loading={isLoading}
                >
                  Retry
                </Button>
              )}

              {canDelete && (
                <Button
                  variant="light"
                  color="red"
                  leftSection={<IconTrash size={16} />}
                  onClick={() => {
                    // TODO: Implement delete with confirmation
                  }}
                >
                  Delete
                </Button>
              )}
            </Group>
          </Group>
        </Stack>
      </Card>

      {/* Error message if failed */}
      {agent.errorMessage && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          title="Error"
          color="red"
        >
          {agent.errorMessage}
        </Alert>
      )}

      {/* Instructions */}
      {agent.instructions && (
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Title order={4} mb="sm">
            Instructions
          </Title>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {agent.instructions}
          </Text>
        </Card>
      )}

      {/* Timestamps */}
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Title order={4} mb="md">
          Timeline
        </Title>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Created
            </Text>
            <Text size="sm">{formatDate(agent.createdAt)}</Text>
          </Group>

          {agent.startedAt && (
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Started
              </Text>
              <Text size="sm">{formatDate(agent.startedAt)}</Text>
            </Group>
          )}

          {agent.suspendedAt && (
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Suspended
              </Text>
              <Text size="sm">{formatDate(agent.suspendedAt)}</Text>
            </Group>
          )}

          {agent.stoppedAt && (
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Stopped
              </Text>
              <Text size="sm">{formatDate(agent.stoppedAt)}</Text>
            </Group>
          )}

          {agent.completedAt && (
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Completed
              </Text>
              <Text size="sm">{formatDate(agent.completedAt)}</Text>
            </Group>
          )}
        </Stack>
      </Card>

      {/* Instance info (if available) */}
      {agent.instanceName && (
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Title order={4} mb="md">
            Instance Details
          </Title>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Instance Name
              </Text>
              <Text size="sm">{agent.instanceName}</Text>
            </Group>

            {agent.instanceZone && (
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  Zone
                </Text>
                <Text size="sm">{agent.instanceZone}</Text>
              </Group>
            )}

            {agent.instanceStatus && (
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  Status
                </Text>
                <Badge variant="light" size="sm">
                  {agent.instanceStatus}
                </Badge>
              </Group>
            )}
          </Stack>
        </Card>
      )}

      {/* Placeholder for Part 3 - Agent conversation */}
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Stack align="center" py="xl">
          <Title order={4} c="dimmed">
            Agent Conversation
          </Title>
          <Text size="sm" c="dimmed" ta="center">
            Agent conversation history will appear here in Part 3.
          </Text>
        </Stack>
      </Card>
    </Stack>
  )
}
