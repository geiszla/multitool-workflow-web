import type { Route } from './+types/_app.agents.$id'
import type { InactivityManagerHandle } from '~/components/agents/InactivityManager'
import type { TerminalHandle } from '~/components/agents/Terminal'
import type { AgentStatus } from '~/models/agent.server'
import type { User } from '~/models/user.server'
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Loader,
  Modal,
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
  IconShare,
  IconTrash,
} from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import { redirect, useFetcher, useLoaderData, useNavigate } from 'react-router'
import { AgentStatusBadge } from '~/components/agents/AgentStatusBadge'
import { FinalReviewModal } from '~/components/agents/FinalReviewModal'
import { InactivityManager } from '~/components/agents/InactivityManager'
import { ShareModal } from '~/components/agents/ShareModal'
import { Terminal } from '~/components/agents/Terminal'
import { useAgentRealtime } from '~/hooks/useAgentRealtime'
import {
  deleteAgent,
  getAgentSharedWith,
  getAgentWithAccess,
  getValidTransitions as getValidTransitionsServer,
  isAgentOwner,
  shareAgent,
  unshareAgent,
  updateAgentStatus,
} from '~/models/agent.server'
import { getUsersByIds } from '~/models/user.server'
import {
  deleteInstance,
  resumeInstance,
  startInstance,
  stopInstance,
  suspendInstance,
} from '~/services/compute.server'
import { requireUser } from '~/services/session.server'
import { getValidTransitions as getValidTransitionsClient } from '~/utils/agent-status'

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
    issueNumber: number
    instructions?: string
    errorMessage?: string
    createdAt: string
    startedAt?: string
    suspendedAt?: string
    stoppedAt?: string
    instanceName?: string
    instanceZone?: string
    terminalReady?: boolean
    cloneStatus?: string
    cloneError?: string
    needsContinue?: boolean
    ownerGithubLogin: string
  }
  isOwner: boolean
  sharedUsers: Array<Pick<User, 'id' | 'githubLogin' | 'avatarUrl'>>
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<LoaderData> {
  const user = await requireUser(request)
  const agentId = params.id

  if (!agentId) {
    throw redirect('/agents')
  }

  try {
    // Use getAgentWithAccess to support shared agents
    const agent = await getAgentWithAccess(agentId, user.id)
    const isOwner = isAgentOwner(agent, user.id)

    // Get shared users if owner
    let sharedUsers: Array<Pick<User, 'id' | 'githubLogin' | 'avatarUrl'>> = []
    if (isOwner && agent.sharedWith && agent.sharedWith.length > 0) {
      const users = await getUsersByIds(agent.sharedWith)
      sharedUsers = users.map(u => ({
        id: u.id,
        githubLogin: u.githubLogin,
        avatarUrl: u.avatarUrl,
      }))
    }

    return {
      agent: {
        id: agent.id,
        title: agent.title,
        status: agent.status,
        repoOwner: agent.repoOwner,
        repoName: agent.repoName,
        branch: agent.branch,
        issueNumber: agent.issueNumber,
        instructions: agent.instructions,
        errorMessage: agent.errorMessage,
        createdAt: agent.createdAt.toDate().toISOString(),
        startedAt: agent.startedAt?.toDate().toISOString(),
        suspendedAt: agent.suspendedAt?.toDate().toISOString(),
        stoppedAt: agent.stoppedAt?.toDate().toISOString(),
        instanceName: agent.instanceName,
        instanceZone: agent.instanceZone,
        terminalReady: agent.terminalReady,
        cloneStatus: agent.cloneStatus,
        cloneError: agent.cloneError,
        needsContinue: agent.needsContinue,
        ownerGithubLogin: agent.ownerGithubLogin,
      },
      isOwner,
      sharedUsers,
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
  deleted?: boolean
  sharedUsers?: Array<Pick<User, 'id' | 'githubLogin' | 'avatarUrl'>>
}

export async function action({ request, params }: Route.ActionArgs): Promise<ActionData | Response> {
  const user = await requireUser(request)
  const agentId = params.id
  const formData = await request.formData()
  const intent = formData.get('intent') as string

  if (!agentId) {
    return { error: 'Agent ID is required' }
  }

  try {
    // Use getAgentWithAccess to support shared users
    const agent = await getAgentWithAccess(agentId, user.id)
    const isOwner = isAgentOwner(agent, user.id)
    const validTransitions = getValidTransitionsServer(agent.status)

    // Handle sharing actions (owner only)
    if (intent === 'share') {
      if (!isOwner) {
        return { error: 'Only the owner can share this agent' }
      }

      const githubLogin = formData.get('githubLogin') as string
      if (!githubLogin) {
        return { error: 'GitHub username is required' }
      }

      try {
        await shareAgent(agentId, user.id, githubLogin.trim())

        // Return updated shared users list
        const sharedWith = await getAgentSharedWith(agentId)
        const users = await getUsersByIds(sharedWith)
        const sharedUsers = users.map(u => ({
          id: u.id,
          githubLogin: u.githubLogin,
          avatarUrl: u.avatarUrl,
        }))

        return { success: true, sharedUsers }
      }
      catch (error) {
        return { error: error instanceof Error ? error.message : 'Failed to share agent' }
      }
    }

    if (intent === 'unshare') {
      if (!isOwner) {
        return { error: 'Only the owner can unshare this agent' }
      }

      const unshareUserId = formData.get('unshareUserId') as string
      if (!unshareUserId) {
        return { error: 'User ID is required' }
      }

      try {
        await unshareAgent(agentId, user.id, unshareUserId)

        // Return updated shared users list
        const sharedWith = await getAgentSharedWith(agentId)
        const users = await getUsersByIds(sharedWith)
        const sharedUsers = users.map(u => ({
          id: u.id,
          githubLogin: u.githubLogin,
          avatarUrl: u.avatarUrl,
        }))

        return { success: true, sharedUsers }
      }
      catch (error) {
        return { error: error instanceof Error ? error.message : 'Failed to unshare agent' }
      }
    }

    // Handle delete action (owner only)
    // IMPORTANT: Delete VM first, only update Firestore if VM delete succeeds
    // This prevents orphaned VMs that would run forever (cost leak)
    if (intent === 'delete') {
      if (!isOwner) {
        return { error: 'Only the owner can delete this agent' }
      }

      // Safety check: If agent is in provisioning status but has no instanceName,
      // refuse to delete - this could orphan a VM that's being created
      if (agent.status === 'provisioning' && !agent.instanceName) {
        return { error: 'Cannot delete agent while VM is being created. Please wait and try again.' }
      }

      // Delete VM first if it exists
      if (agent.instanceName && agent.instanceZone) {
        try {
          await deleteInstance(agent.instanceName, agent.instanceZone)
        }
        catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          console.error('Failed to delete VM:', message)
          // Do NOT delete from Firestore if VM deletion fails - prevents orphaned VMs
          return { error: `Failed to delete VM: ${message}. Agent not deleted.` }
        }
      }

      // VM deleted successfully (or didn't exist), now delete from Firestore
      await deleteAgent(agentId)

      // Redirect to agents list
      return redirect('/agents')
    }

    // Map intent to target status
    // Note: 'cancel' is removed - use 'delete' action instead (which removes the doc entirely)
    const statusMap: Record<string, AgentStatus> = {
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

    // Trigger GCE operations
    if (agent.instanceName && agent.instanceZone) {
      try {
        switch (intent) {
          case 'suspend':
            await suspendInstance(agent.instanceName, agent.instanceZone)
            break
          case 'stop':
            await stopInstance(agent.instanceName, agent.instanceZone)
            break
          case 'resume':
            await resumeInstance(agent.instanceName, agent.instanceZone)
            break
          case 'start':
            await startInstance(agent.instanceName, agent.instanceZone)
            break
        }
      }
      catch (error) {
        console.error(`Failed to ${intent} VM:`, error instanceof Error ? error.message : 'Unknown error')
        return { error: `Failed to ${intent} VM: ${error instanceof Error ? error.message : 'Unknown error'}` }
      }
    }

    // Update agent status with appropriate metadata
    let metadata: Record<string, unknown> | undefined
    if (intent === 'stop') {
      metadata = { needsContinue: true }
    }
    else if (intent === 'start') {
      // For stopped -> running transition, reset terminal ready state
      // terminalReady should be false until pty-server reports ready
      // NOTE: internalIp is NOT stored in Firestore - fetched on-demand from GCE
      metadata = { terminalReady: false }
    }
    await updateAgentStatus(agentId, agent.status, targetStatus, metadata)

    return { success: true }
  }
  catch (error) {
    console.error('Agent action error:', error instanceof Error ? error.message : 'Unknown error')
    return { error: 'Failed to perform action. Please try again.' }
  }
}

// Prompt sent to Claude Code to do final review
const FINISH_PROMPT = `Please complete your work and prepare a pull request:

1. Run a Codex code review on all your changes using the /review-pr skill or manually if needed
2. Address any critical issues from the review
3. Commit all local changes with a descriptive commit message
4. Push to a new branch (use a descriptive branch name based on the work done)
5. Create a pull request with a summary of the changes

Please proceed autonomously and let me know when you're done or if you encounter any issues.`

export default function AgentView() {
  const loaderData = useLoaderData<LoaderData>()
  const navigate = useNavigate()
  const fetcher = useFetcher<ActionData>()
  const terminalRef = useRef<TerminalHandle>(null)
  const inactivityRef = useRef<InactivityManagerHandle>(null)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [finalReviewModalOpen, setFinalReviewModalOpen] = useState(false)
  const [finalReviewError, setFinalReviewError] = useState<string | undefined>()

  const { isOwner, sharedUsers: loaderSharedUsers } = loaderData
  // Use fetcher data if available (after share/unshare action)
  const sharedUsers = fetcher.data?.sharedUsers ?? loaderSharedUsers

  // Use realtime data if available, fall back to loader data
  const { agent: realtimeAgent } = useAgentRealtime(loaderData.agent.id)

  // Merge realtime data with loader data (realtime takes precedence)
  const agent = {
    ...loaderData.agent,
    status: realtimeAgent?.status ?? loaderData.agent.status,
    terminalReady: realtimeAgent?.terminalReady ?? loaderData.agent.terminalReady,
    cloneStatus: realtimeAgent?.cloneStatus ?? loaderData.agent.cloneStatus,
    cloneError: realtimeAgent?.cloneError ?? loaderData.agent.cloneError,
    errorMessage: realtimeAgent?.errorMessage ?? loaderData.agent.errorMessage,
  }

  // Compute validActions from current realtime status using client-safe utility
  // This ensures buttons update correctly when status changes via realtime
  const validActions = getValidTransitionsClient(agent.status)
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

  const handleDelete = () => {
    setDeleteModalOpen(false)
    fetcher.submit({ intent: 'delete' }, { method: 'post' })
  }

  const handleFinalReview = () => {
    if (!terminalRef.current) {
      setFinalReviewError('Terminal is not connected')
      return
    }

    if (!terminalRef.current.isConnected()) {
      setFinalReviewError('Terminal is not connected')
      return
    }

    // Send the final review prompt to the terminal
    // Add newline to execute the prompt
    terminalRef.current.sendInput(`${FINISH_PROMPT}\n`)
    setFinalReviewModalOpen(false)
    setFinalReviewError(undefined)
  }

  // Determine which action buttons to show
  // Note: Cancel action removed - use Delete instead (which removes the agent entirely)
  const canSuspend = validActions.includes('suspended')
  const canStop = validActions.includes('stopped')
  const canResume = agent.status === 'suspended' && validActions.includes('running')
  const canStart = agent.status === 'stopped' && validActions.includes('running')
  // Allow delete on terminal states + stopped + suspended (not running/provisioning)
  // Suspended VMs should be deletable since they still incur some cost
  // Allow delete on terminal states + stopped + suspended + provisioning (not running)
  // Suspended VMs should be deletable since they still incur some cost
  // Provisioning VMs should be deletable in case of stuck provisioning
  const canDelete = isOwner && ['failed', 'stopped', 'pending', 'suspended', 'provisioning'].includes(agent.status)
  const canShare = isOwner
  // const canDoFinalReview = isOwner && agent.status === 'running' && agent.terminalReady

  // Callback for Terminal to signal activity to InactivityManager
  const handleTerminalActivity = useCallback(() => {
    inactivityRef.current?.signalActivity()
  }, [])

  // Terminal visibility conditions
  // Terminal is shown for:
  // - running + terminalReady: normal operation
  // - suspended: Terminal handles auto-resume via its resumeAgent callback
  // - stopped: Terminal handles auto-resume via its resumeAgent callback
  const showTerminal = (agent.status === 'running' && agent.terminalReady)
    || agent.status === 'suspended'
    || agent.status === 'stopped'
  const showProvisioningStatus = ['pending', 'provisioning'].includes(agent.status)
  const showConnectingStatus = agent.status === 'running' && !agent.terminalReady
  // Note: showSuspendedStatus and showStoppedStatus are removed as Terminal now handles these
  const showFailedStatus = agent.status === 'failed'

  return (
    <Stack gap="lg">
      {/* Header with back button */}
      <Group justify="space-between" align="flex-start">
        <Button
          variant="subtle"
          leftSection={<IconArrowLeft size={16} />}
          onClick={() => navigate('/agents')}
        >
          Back to Agents
        </Button>
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

                <Anchor
                  href={`https://github.com/${agent.repoOwner}/${agent.repoName}/issues/${agent.issueNumber}`}
                  target="_blank"
                  c="dimmed"
                  size="sm"
                >
                  #
                  {agent.issueNumber}
                </Anchor>
              </Group>
            </div>

            {/* Action buttons */}
            <Group>
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

              {/* {canDoFinalReview && (
                <Button
                  variant="light"
                  color="green"
                  leftSection={<IconCheck size={16} />}
                  onClick={() => setFinalReviewModalOpen(true)}
                >
                  Final Review
                </Button>
              )} */}

              {canShare && (
                <Button
                  variant="light"
                  color="grape"
                  leftSection={<IconShare size={16} />}
                  onClick={() => setShareModalOpen(true)}
                >
                  Share
                </Button>
              )}

              {canDelete && (
                <Button
                  variant="light"
                  color="red"
                  leftSection={<IconTrash size={16} />}
                  onClick={() => setDeleteModalOpen(true)}
                  loading={isLoading}
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

      {/* Clone error */}
      {agent.cloneError && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          title="Clone Error"
          color="orange"
        >
          {agent.cloneError}
        </Alert>
      )}

      {/* Terminal / Status Display */}
      <Card shadow="sm" padding="lg" radius="md" withBorder style={{ minHeight: 800 }}>
        {showTerminal && (
          <div style={{ height: 800 }}>
            <InactivityManager
              ref={inactivityRef}
              agentId={agent.id}
              isRunning={agent.status === 'running'}
              terminalReady={agent.terminalReady ?? false}
              terminalRef={terminalRef}
            >
              <Terminal
                ref={terminalRef}
                agentId={agent.id}
                agentStatus={agent.status}
                onActivity={handleTerminalActivity}
              />
            </InactivityManager>
          </div>
        )}

        {showProvisioningStatus && (
          <Stack align="center" justify="center" py="xl" h={400}>
            <Loader size="lg" />
            <Title order={4} c="dimmed">
              {agent.status === 'pending' ? 'Starting...' : 'Provisioning VM...'}
            </Title>
            {agent.cloneStatus === 'cloning' && (
              <Text size="sm" c="dimmed">
                Cloning repository...
              </Text>
            )}
          </Stack>
        )}

        {showConnectingStatus && (
          <Stack align="center" justify="center" py="xl" h={400}>
            <Loader size="lg" />
            <Title order={4} c="dimmed">
              Connecting to agent...
            </Title>
            <Text size="sm" c="dimmed">
              Terminal will be available shortly
            </Text>
          </Stack>
        )}

        {/* Note: Suspended and Stopped states are now handled by Terminal's auto-resume */}

        {showFailedStatus && (
          <Stack align="center" justify="center" py="xl" h={400}>
            <IconAlertCircle size={48} color="var(--mantine-color-red-6)" />
            <Title order={4} c="dimmed">
              Failed
            </Title>
            <Text size="sm" c="dimmed" ta="center">
              The agent encountered an error.
            </Text>
          </Stack>
        )}
      </Card>

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
          </Stack>
        </Card>
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        opened={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Agent"
        centered
      >
        <Stack>
          <Text>
            Are you sure you want to delete
            {' '}
            <strong>{agent.title}</strong>
            ?
          </Text>
          <Text size="sm" c="dimmed">
            This will delete the agent record and any associated VM resources. This action cannot be undone.
          </Text>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={handleDelete} loading={isLoading}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Share Modal */}
      <ShareModal
        opened={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        agentId={agent.id}
        agentTitle={agent.title}
        sharedUsers={sharedUsers}
      />

      {/* Final review Modal */}
      <FinalReviewModal
        opened={finalReviewModalOpen}
        onClose={() => {
          setFinalReviewModalOpen(false)
          setFinalReviewError(undefined)
        }}
        onConfirm={handleFinalReview}
        isLoading={false}
        error={finalReviewError}
      />
    </Stack>
  )
}
