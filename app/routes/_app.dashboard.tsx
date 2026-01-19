import type { Route } from './+types/_app.dashboard'
import {
  Badge,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { IconGitBranch, IconHistory, IconPlus } from '@tabler/icons-react'
import { useLoaderData } from 'react-router'

export function meta() {
  return [
    { title: 'Dashboard - Multitool Workflow' },
    { name: 'description', content: 'Your workflow dashboard' },
  ]
}

export async function loader(_args: Route.LoaderArgs) {
  // TODO: Load user's recent workflows from Firestore
  return {
    recentWorkflows: [],
    stats: {
      totalWorkflows: 0,
      activeWorkflows: 0,
      completedWorkflows: 0,
    },
  }
}

export default function Dashboard() {
  const { recentWorkflows, stats } = useLoaderData<typeof loader>()

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={1}>Dashboard</Title>
          <Text c="dimmed">
            Welcome back! Here&apos;s an overview of your workflows.
          </Text>
        </div>
        <Button leftSection={<IconPlus size={18} />} disabled>
          New Workflow
        </Button>
      </Group>

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="xs">
            <Text size="sm" fw={500} c="dimmed">
              Total Workflows
            </Text>
            <IconGitBranch size={20} color="var(--mantine-color-dimmed)" />
          </Group>
          <Title order={2}>{stats.totalWorkflows}</Title>
          <Text size="xs" c="dimmed">
            All time workflow runs
          </Text>
        </Card>

        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="xs">
            <Text size="sm" fw={500} c="dimmed">
              Active
            </Text>
            <Badge size="sm" color="green" variant="filled" circle>
              {' '}
            </Badge>
          </Group>
          <Title order={2}>{stats.activeWorkflows}</Title>
          <Text size="xs" c="dimmed">
            Currently running workflows
          </Text>
        </Card>

        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Group justify="space-between" mb="xs">
            <Text size="sm" fw={500} c="dimmed">
              Completed
            </Text>
            <IconHistory size={20} color="var(--mantine-color-dimmed)" />
          </Group>
          <Title order={2}>{stats.completedWorkflows}</Title>
          <Text size="xs" c="dimmed">
            Successfully finished
          </Text>
        </Card>
      </SimpleGrid>

      {/* Recent Workflows */}
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Title order={3} mb="xs">
          Recent Workflows
        </Title>
        <Text size="sm" c="dimmed" mb="lg">
          Your most recent workflow runs across all repositories.
        </Text>

        {recentWorkflows.length === 0
          ? (
              <Stack align="center" py="xl">
                <IconGitBranch size={48} color="var(--mantine-color-dimmed)" />
                <Title order={4}>No workflows yet</Title>
                <Text size="sm" c="dimmed" ta="center">
                  Start your first AI-assisted workflow on a GitHub repository.
                </Text>
                <Button leftSection={<IconPlus size={18} />} disabled mt="md">
                  Create your first workflow
                </Button>
              </Stack>
            )
          : (
              <Stack>
                {/* TODO: Render workflow list */}
                <Text c="dimmed">Workflow list will be displayed here.</Text>
              </Stack>
            )}
      </Card>
    </Stack>
  )
}
