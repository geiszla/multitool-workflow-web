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
  isActiveStatus,
  listAccessibleAgents,
  updateAgentStatus,
} from '~/models/agent.server'
import { getExternalAuth, hasExternalAuth } from '~/models/external-auth.server'
import { createAgentInstanceAsync } from '~/services/compute.server'
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
    issueNumber?: number
    issueTitle?: string
    createdAt: string
    ownerGithubLogin: string
    isOwned: boolean
  }>
  claudeConfigured: boolean
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
      repos = await listUserRepos(githubToken, { limit: 50 })
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
      issueTitle: agent.issueTitle,
      createdAt: agent.createdAt.toDate().toISOString(),
      ownerGithubLogin: agent.ownerGithubLogin,
      isOwned: agent.userId === user.id,
    })),
    claudeConfigured,
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
    const title = formData.get('title') as string
    const issueNumber = formData.get('issueNumber') as string
    const issueTitle = formData.get('issueTitle') as string
    const instructions = formData.get('instructions') as string

    if (!repoOwner || !repoName || !branch) {
      return { error: 'Repository, branch are required' }
    }

    // Verify Claude API key is configured
    const claudeConfigured = await hasExternalAuth(user.id, 'claude')
    if (!claudeConfigured) {
      return { error: 'Claude API key must be configured in settings' }
    }

    // Validate issueNumber is a valid number if provided
    let parsedIssueNumber: number | undefined
    if (issueNumber) {
      const num = Number(issueNumber)
      if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
        return { error: 'Invalid issue number' }
      }
      parsedIssueNumber = num
    }

    try {
      const agent = await createAgent({
        userId: user.id,
        ownerGithubLogin: user.githubLogin,
        title: title || undefined,
        repoOwner,
        repoName,
        branch,
        issueNumber: parsedIssueNumber,
        issueTitle: issueTitle || undefined,
        instructions: instructions || undefined,
      })

      // Trigger async VM provisioning
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

        // Update agent to provisioning status with operation details
        await updateAgentStatus(agent.id, 'pending', 'provisioning', {
          instanceName: result.instanceName,
          instanceZone: result.zone,
          provisioningOperationId: result.operationId,
          cloneStatus: 'pending',
        })
      }
      catch (vmError) {
        // If VM creation fails, update agent to failed status
        console.error('Failed to start VM:', vmError instanceof Error ? vmError.message : 'Unknown error')
        await updateAgentStatus(agent.id, 'pending', 'failed', {
          errorMessage: `Failed to start VM: ${vmError instanceof Error ? vmError.message : 'Unknown error'}`,
        })
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
  const { repos, agents, claudeConfigured } = useLoaderData<LoaderData>()

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
        claudeConfigured={claudeConfigured}
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
                    issueTitle={agent.issueTitle}
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
