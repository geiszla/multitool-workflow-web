import type { Route } from './+types/_app.agents'
import type { BranchDto, IssueDto, RepoDto } from '~/services/github-api.server'
import {
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { useLoaderData } from 'react-router'
import { AgentCard } from '~/components/agents/AgentCard'
import { NewAgentForm } from '~/components/agents/NewAgentForm'
import {
  createAgent,
  getAgent,
  isActiveStatus,
  listAccessibleAgents,
  updateAgentStatus,
} from '~/models/agent.server'
import { getExternalAuth, hasExternalAuth } from '~/models/external-auth.server'
import { createAgentInstanceAsync, waitForOperation } from '~/services/compute.server'
import {
  listRepoBranches,
  listRepoIssues,
  listUserRepos,
} from '~/services/github-api.server'
import { requireUser } from '~/services/session.server'

export function meta() {
  return [
    { title: 'Agents - Multitool Workflow' },
    { name: 'description', content: 'Create and manage AI agents' },
  ]
}

interface LoaderData {
  repos: RepoDto[]
  agents: Array<{
    id: string
    title: string
    status: string
    repoOwner: string
    repoName: string
    issueNumber: number
    createdAt: string
    ownerGithubLogin: string
    isOwned: boolean
  }>
  claudeConfigured: boolean
  isComped: boolean // True if user is comped (uses org API keys)
  hasActiveAgents: boolean
  currentUserId: string
}

export async function loader({ request }: Route.LoaderArgs): Promise<LoaderData> {
  const user = await requireUser(request)

  // Load repos, agents, and check Claude config in parallel
  const [githubToken, claudeConfigured, agents] = await Promise.all([
    getExternalAuth(user.id, 'github'),
    hasExternalAuth(user.id, 'claude'),
    listAccessibleAgents(user.id),
  ])

  // Load repos if GitHub token is available
  let repos: RepoDto[] = []
  if (githubToken) {
    try {
      const result = await listUserRepos(githubToken, { limit: 50 })
      repos = result.repos
    }
    catch (error) {
      console.error('Failed to load repos:', error instanceof Error ? error.message : 'Unknown error')
    }
  }

  // Check if any agents are active (need polling)
  const hasActiveAgents = agents.some(agent => isActiveStatus(agent.status))

  return {
    repos,
    agents: agents.map(agent => ({
      id: agent.id,
      title: agent.title,
      status: agent.status,
      repoOwner: agent.repoOwner,
      repoName: agent.repoName,
      issueNumber: agent.issueNumber,
      createdAt: agent.createdAt.toDate().toISOString(),
      ownerGithubLogin: agent.ownerGithubLogin,
      isOwned: agent.userId === user.id,
    })),
    claudeConfigured,
    isComped: user.isComped ?? false,
    hasActiveAgents,
    currentUserId: user.id,
  }
}

interface ActionData {
  success?: boolean
  agentId?: string
  error?: string
  branches?: BranchDto[]
  issues?: IssueDto[]
}

export async function action({ request }: Route.ActionArgs): Promise<ActionData> {
  const user = await requireUser(request)
  const formData = await request.formData()
  const intent = formData.get('intent')

  // Load repo data (branches and issues)
  if (intent === 'loadRepoData') {
    const owner = formData.get('owner') as string
    const repo = formData.get('repo') as string

    if (!owner || !repo) {
      return { error: 'Repository owner and name are required' }
    }

    try {
      const githubToken = await getExternalAuth(user.id, 'github')
      if (!githubToken) {
        return { error: 'GitHub authentication required' }
      }

      const [branches, issues] = await Promise.all([
        listRepoBranches(githubToken, owner, repo),
        listRepoIssues(githubToken, owner, repo),
      ])

      return { branches, issues }
    }
    catch (error) {
      console.error('Failed to load repo data:', error instanceof Error ? error.message : 'Unknown error')
      return { error: 'Failed to load repository data' }
    }
  }

  // Create new agent
  if (intent === 'create') {
    const repoOwner = formData.get('repoOwner') as string
    const repoName = formData.get('repoName') as string
    const branch = formData.get('branch') as string
    const issueNumber = formData.get('issueNumber') as string
    const title = formData.get('title') as string
    const instructions = formData.get('instructions') as string

    if (!repoOwner || !repoName || !branch || !issueNumber || !title) {
      return { error: 'Repository, branch, and issue are required' }
    }

    // Verify Claude API key is configured (unless user is comped)
    const claudeConfigured = await hasExternalAuth(user.id, 'claude')
    if (!claudeConfigured && !(user.isComped ?? false)) {
      return { error: 'Claude API key must be configured in settings' }
    }

    // Validate issueNumber is a valid number (required)
    const parsedIssueNumber = Number(issueNumber)
    if (!Number.isFinite(parsedIssueNumber) || parsedIssueNumber <= 0 || !Number.isInteger(parsedIssueNumber)) {
      return { error: 'Invalid issue number' }
    }

    try {
      const agent = await createAgent({
        userId: user.id,
        ownerGithubLogin: user.githubLogin,
        repoOwner,
        repoName,
        branch,
        issueNumber: parsedIssueNumber,
        title,
        instructions: instructions || undefined,
      })

      // Start VM provisioning and wait for completion
      try {
        const result = await createAgentInstanceAsync({
          agentId: agent.id,
          userId: user.id,
          repoOwner,
          repoName,
          branch,
          issueNumber: parsedIssueNumber,
          instructions: instructions || undefined,
        })

        // IMPORTANT: Store instanceName/zone IMMEDIATELY after GCE insert returns
        // This allows cleanup if the request times out while waiting for the operation
        // It also allows VM identity verification once the VM boots
        await updateAgentStatus(agent.id, 'pending', 'provisioning', {
          instanceName: result.instanceName,
          instanceZone: result.zone,
          cloneStatus: 'pending',
        })

        // Wait for the GCE operation to complete (polls every 2s, 5min timeout)
        // Note: If this times out, the agent is in 'provisioning' with instanceName set,
        // so the VM can still authenticate and complete setup
        await waitForOperation(result.operationId, result.zone)

        // Operation succeeded - agent is already in 'provisioning' status
        // VM bootstrap will transition to 'running' when pty-server is ready
      }
      catch (vmError) {
        const errorMessage = vmError instanceof Error ? vmError.message : 'Unknown error'
        const isTimeout = errorMessage.includes('timed out')

        // Check current agent status - may already be in 'provisioning' if the insert succeeded
        const currentAgent = await getAgent(agent.id)
        const fromStatus = currentAgent?.status ?? 'pending'

        if (isTimeout && fromStatus === 'provisioning') {
          // Timeout while waiting for operation - VM may still boot successfully
          // Leave in 'provisioning' status so VM can authenticate and complete setup
          // This is not an error - just a slow boot
          console.warn('VM provisioning timeout (will continue in background):', errorMessage)
          // Return success - agent is in provisioning, VM will update status when ready
          return { success: true, agentId: agent.id }
        }

        // Actual failure (not timeout) - update to failed status
        console.error('VM provisioning failed:', errorMessage)

        // Only transition to failed if it's a valid transition
        if (fromStatus === 'pending' || fromStatus === 'provisioning') {
          await updateAgentStatus(agent.id, fromStatus, 'failed', {
            errorMessage: `VM provisioning failed: ${errorMessage}`,
          })
        }
        return { error: `VM provisioning failed: ${errorMessage}` }
      }

      return { success: true, agentId: agent.id }
    }
    catch (error) {
      console.error('Failed to create agent:', error instanceof Error ? error.message : 'Unknown error')
      return { error: 'Failed to create agent. Please try again.' }
    }
  }

  return { error: 'Invalid action' }
}

export default function Agents() {
  const { repos, agents, claudeConfigured, isComped } = useLoaderData<LoaderData>()

  // Comped users can create agents without their own Claude API key
  const canCreateAgents = claudeConfigured || isComped

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>Agents</Title>
        <Text c="dimmed">
          Create and manage AI agents that work on your GitHub repositories.
        </Text>
      </div>

      <NewAgentForm
        repos={repos}
        claudeConfigured={canCreateAgents}
      />

      {/* Agent History */}
      <div>
        <Title order={3} mb="md">
          Agent History
        </Title>

        {agents.length === 0
          ? (
              <Text c="dimmed" ta="center" py="xl">
                No agents yet. Create your first agent above!
              </Text>
            )
          : (
              <Stack gap="md">
                {agents.map(agent => (
                  <AgentCard
                    key={agent.id}
                    id={agent.id}
                    title={agent.title}
                    status={agent.status}
                    repoOwner={agent.repoOwner}
                    repoName={agent.repoName}
                    issueNumber={agent.issueNumber}
                    createdAt={agent.createdAt}
                    ownerGithubLogin={agent.ownerGithubLogin}
                    isOwned={agent.isOwned}
                  />
                ))}
              </Stack>
            )}
      </div>
    </Stack>
  )
}
