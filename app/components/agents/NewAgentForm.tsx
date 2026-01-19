import type { BranchDto, IssueDto, RepoDto } from '~/services/github-api.server'
import {
  Alert,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import { IconAlertCircle, IconRocket, IconSettings } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useFetcher, useNavigate } from 'react-router'

interface NewAgentFormProps {
  /** List of user's repositories */
  repos: RepoDto[]
  /** Whether Claude API key is configured */
  claudeConfigured: boolean
}

export function NewAgentForm({
  repos,
  claudeConfigured,
}: NewAgentFormProps) {
  const navigate = useNavigate()
  const fetcher = useFetcher<{
    success?: boolean
    agentId?: string
    error?: string
    branches?: BranchDto[]
    issues?: IssueDto[]
  }>()

  // Form state
  const [title, setTitle] = useState('')
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')

  // Loaded data
  const [branches, setBranches] = useState<BranchDto[]>([])
  const [issues, setIssues] = useState<IssueDto[]>([])

  // Track previous repo for detecting changes
  const prevRepoRef = useRef<string | null>(null)

  const isLoading = fetcher.state !== 'idle'
  const isLoadingRepoData = isLoading && fetcher.formData?.get('intent') === 'loadRepoData'
  const isCreating = isLoading && fetcher.formData?.get('intent') === 'create'

  // Parse selected repo
  const selectedRepoData = selectedRepo
    ? repos.find(r => r.fullName === selectedRepo)
    : null

  // Handle repo selection change - reset dependent state and load new data
  // Using useEffect is appropriate here as this is a response to user interaction
  // that triggers a side effect (resetting state and fetching data)
  useEffect(() => {
    // Skip on initial render
    if (prevRepoRef.current === selectedRepo) {
      return
    }
    prevRepoRef.current = selectedRepo

    if (selectedRepoData) {
      // Reset dependent state when repo changes
      // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- Intentional: resetting cascading form state when parent selection changes
      setSelectedBranch(null)
      // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- Intentional: resetting cascading form state when parent selection changes
      setSelectedIssue(null)
      // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- Intentional: clearing loaded data when repo changes
      setBranches([])
      // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- Intentional: clearing loaded data when repo changes
      setIssues([])

      // Load branches and issues for the new repo
      fetcher.submit(
        {
          intent: 'loadRepoData',
          owner: selectedRepoData.owner,
          repo: selectedRepoData.name,
        },
        { method: 'post' },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher.submit is stable
  }, [selectedRepo, selectedRepoData])

  // Handle fetcher data changes - update branches/issues state
  // This is appropriate because we're synchronizing with fetcher results
  useEffect(() => {
    if (fetcher.data?.branches) {
      // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- Intentional: synchronizing state with fetcher response
      setBranches(fetcher.data.branches)
      // Auto-select default branch
      if (selectedRepoData?.defaultBranch) {
        // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- Intentional: auto-selecting default branch on data load
        setSelectedBranch(selectedRepoData.defaultBranch)
      }
    }
    if (fetcher.data?.issues) {
      // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- Intentional: synchronizing state with fetcher response
      setIssues(fetcher.data.issues)
    }
  }, [fetcher.data, selectedRepoData?.defaultBranch])

  // Handle successful agent creation - redirect to agent page
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.agentId) {
      navigate(`/agents/${fetcher.data.agentId}`)
    }
  }, [fetcher.data, navigate])

  const handleSubmit = () => {
    if (!selectedRepoData || !selectedBranch)
      return

    const selectedIssueData = selectedIssue
      ? issues.find(i => String(i.number) === selectedIssue)
      : null

    fetcher.submit(
      {
        intent: 'create',
        title: title.trim() || '',
        repoOwner: selectedRepoData.owner,
        repoName: selectedRepoData.name,
        branch: selectedBranch,
        issueNumber: selectedIssueData?.number?.toString() || '',
        issueTitle: selectedIssueData?.title || '',
        instructions: instructions.trim(),
      },
      { method: 'post' },
    )
  }

  const canSubmit = selectedRepoData && selectedBranch && claudeConfigured && !isLoading

  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder>
      <Stack gap="md">
        <div>
          <Title order={3}>Start New Agent</Title>
          <Text size="sm" c="dimmed">
            Configure and launch an AI agent to work on a GitHub issue.
          </Text>
        </div>

        {!claudeConfigured && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            title="Claude API key required"
            color="yellow"
          >
            <Group justify="space-between" align="center">
              <Text size="sm">
                Please configure your Claude API key in settings to create agents.
              </Text>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconSettings size={14} />}
                onClick={() => navigate('/settings')}
              >
                Settings
              </Button>
            </Group>
          </Alert>
        )}

        {fetcher.data?.error && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            title="Error"
            color="red"
          >
            {fetcher.data.error}
          </Alert>
        )}

        <TextInput
          label="Title"
          description="Optional. Auto-generated from repo/issue if empty."
          placeholder="My awesome feature"
          value={title}
          onChange={e => setTitle(e.currentTarget.value)}
          disabled={isCreating}
        />

        <Select
          label="Repository"
          description="Select a GitHub repository"
          placeholder="Search repositories..."
          searchable
          data={repos.map(repo => ({
            value: repo.fullName,
            label: repo.fullName,
          }))}
          value={selectedRepo}
          onChange={setSelectedRepo}
          disabled={isCreating}
          nothingFoundMessage="No repositories found"
        />

        <Group grow>
          <Select
            label="Branch"
            description="Target branch for changes"
            placeholder={isLoadingRepoData ? 'Loading...' : 'Select branch'}
            data={branches.map(b => ({
              value: b.name,
              label: `${b.name}${b.protected ? ' (protected)' : ''}`,
            }))}
            value={selectedBranch}
            onChange={setSelectedBranch}
            disabled={!selectedRepo || isLoadingRepoData || isCreating}
            nothingFoundMessage="No branches found"
          />

          <Select
            label="Issue"
            description="Optional GitHub issue to work on"
            placeholder={isLoadingRepoData ? 'Loading...' : 'Select issue (optional)'}
            data={issues.map(i => ({
              value: String(i.number),
              label: `#${i.number}: ${i.title}`,
            }))}
            value={selectedIssue}
            onChange={setSelectedIssue}
            disabled={!selectedRepo || isLoadingRepoData || isCreating}
            clearable
            nothingFoundMessage="No open issues found"
          />
        </Group>

        <Textarea
          label="Instructions"
          description="Optional instructions for the agent"
          placeholder="Additional context or instructions for the AI agent..."
          value={instructions}
          onChange={e => setInstructions(e.currentTarget.value)}
          disabled={isCreating}
          minRows={3}
          maxRows={6}
          maxLength={10000}
        />

        <Group justify="flex-end">
          <Button
            leftSection={<IconRocket size={18} />}
            onClick={handleSubmit}
            loading={isCreating}
            disabled={!canSubmit}
          >
            Start Agent
          </Button>
        </Group>
      </Stack>
    </Card>
  )
}
