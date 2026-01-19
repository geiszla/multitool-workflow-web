import type { Route } from './+types/_app.settings'
import type { ToolName } from '~/models/external-auth.server'
import {
  Alert,
  Avatar,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import {
  IconBrandGithub,
  IconInfoCircle,
  IconRobot,
  IconSparkles,
} from '@tabler/icons-react'
import { useFetcher, useLoaderData } from 'react-router'
import { ApiKeyInput } from '~/components/settings/ApiKeyInput'
import { ExternalToolCard } from '~/components/settings/ExternalToolCard'
import {
  deleteExternalAuth,
  getExternalAuthSuffix,
  hasExternalAuth,
  saveExternalAuth,
} from '~/models/external-auth.server'
import { requireUser } from '~/services/session.server'

export function meta() {
  return [
    { title: 'Settings - Multitool Workflow' },
    { name: 'description', content: 'Configure your external tool integrations' },
  ]
}

interface LoaderData {
  user: {
    githubLogin: string
    avatarUrl: string
  }
  tools: {
    claude: { configured: boolean, suffix: string | null }
    codex: { configured: boolean, suffix: string | null }
    github: { configured: boolean }
  }
}

export async function loader({ request }: Route.LoaderArgs): Promise<LoaderData> {
  const user = await requireUser(request)

  // Check which tools are configured
  const [claudeConfigured, codexConfigured, githubConfigured] = await Promise.all([
    hasExternalAuth(user.id, 'claude'),
    hasExternalAuth(user.id, 'codex'),
    hasExternalAuth(user.id, 'github'),
  ])

  // Get suffixes for configured tools
  const [claudeSuffix, codexSuffix] = await Promise.all([
    claudeConfigured ? getExternalAuthSuffix(user.id, 'claude') : null,
    codexConfigured ? getExternalAuthSuffix(user.id, 'codex') : null,
  ])

  return {
    user: {
      githubLogin: user.githubLogin,
      avatarUrl: user.avatarUrl,
    },
    tools: {
      claude: { configured: claudeConfigured, suffix: claudeSuffix },
      codex: { configured: codexConfigured, suffix: codexSuffix },
      github: { configured: githubConfigured },
    },
  }
}

interface ActionData {
  success?: boolean
  error?: string
  tool?: ToolName
  action?: 'save' | 'delete'
}

export async function action({ request }: Route.ActionArgs): Promise<ActionData> {
  const user = await requireUser(request)
  const formData = await request.formData()

  const intent = formData.get('intent')
  const toolName = formData.get('toolName') as ToolName

  if (!toolName || !['claude', 'codex'].includes(toolName)) {
    return { error: 'Invalid tool name' }
  }

  try {
    if (intent === 'save') {
      const apiKey = formData.get('apiKey') as string
      if (!apiKey || apiKey.trim().length === 0) {
        return { error: 'API key is required' }
      }

      await saveExternalAuth(user.id, toolName, apiKey.trim())
      return { success: true, tool: toolName, action: 'save' }
    }
    else if (intent === 'delete') {
      await deleteExternalAuth(user.id, toolName)
      return { success: true, tool: toolName, action: 'delete' }
    }

    return { error: 'Invalid action' }
  }
  catch (error) {
    console.error('Settings action error:', error instanceof Error ? error.message : 'Unknown error')
    return { error: 'Failed to update settings. Please try again.' }
  }
}

export default function Settings() {
  const { user, tools } = useLoaderData<LoaderData>()
  const fetcher = useFetcher<ActionData>()

  const isLoading = fetcher.state !== 'idle'
  const loadingTool = fetcher.formData?.get('toolName') as ToolName | null

  const handleSave = (toolName: ToolName, apiKey: string) => {
    fetcher.submit(
      { intent: 'save', toolName, apiKey },
      { method: 'post' },
    )
  }

  const handleDelete = (toolName: ToolName) => {
    fetcher.submit(
      { intent: 'delete', toolName },
      { method: 'post' },
    )
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>Settings</Title>
        <Text c="dimmed">
          Configure your external tool integrations for AI-assisted workflows.
        </Text>
      </div>

      {fetcher.data?.error && (
        <Alert
          icon={<IconInfoCircle size={16} />}
          title="Error"
          color="red"
          withCloseButton
        >
          {fetcher.data.error}
        </Alert>
      )}

      <Stack gap="md">
        {/* Claude API */}
        <ExternalToolCard
          title="Claude API"
          description="Anthropic's Claude API for code generation and analysis"
          icon={<IconSparkles size={20} />}
          isConfigured={tools.claude.configured}
        >
          <ApiKeyInput
            toolName="claude"
            label="Claude API Key"
            placeholder="sk-ant-..."
            isConfigured={tools.claude.configured}
            keySuffix={tools.claude.suffix}
            isLoading={isLoading && loadingTool === 'claude'}
            onSave={key => handleSave('claude', key)}
            onDelete={() => handleDelete('claude')}
          />
        </ExternalToolCard>

        {/* Codex API */}
        <ExternalToolCard
          title="Codex"
          description="OpenAI Codex API for code completion and generation"
          icon={<IconRobot size={20} />}
          isConfigured={tools.codex.configured}
        >
          <ApiKeyInput
            toolName="codex"
            label="Codex API Key"
            placeholder="sk-..."
            isConfigured={tools.codex.configured}
            keySuffix={tools.codex.suffix}
            isLoading={isLoading && loadingTool === 'codex'}
            onSave={key => handleSave('codex', key)}
            onDelete={() => handleDelete('codex')}
          />
        </ExternalToolCard>

        {/* GitHub (OAuth - read-only display) */}
        <ExternalToolCard
          title="GitHub"
          description="GitHub authentication for repository access"
          icon={<IconBrandGithub size={20} />}
          isConfigured={tools.github.configured}
        >
          <Group gap="md">
            <Avatar src={user.avatarUrl} size="md" radius="xl" />
            <div>
              <Text size="sm" fw={500}>
                @
                {user.githubLogin}
              </Text>
              <Text size="xs" c="dimmed">
                Connected via OAuth. Re-authenticate to update permissions.
              </Text>
            </div>
          </Group>
        </ExternalToolCard>
      </Stack>
    </Stack>
  )
}
