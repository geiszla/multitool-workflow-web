import {
  Anchor,
  Box,
  Button,
  Card,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import {
  IconBrandGithub,
  IconCloud,
  IconGitBranch,
  IconShield,
} from '@tabler/icons-react'
import { Link } from 'react-router'

export function meta() {
  return [
    { title: 'Multitool Workflow - AI-Assisted GitHub Workflows' },
    {
      name: 'description',
      content:
        'Run AI-assisted workflows on your GitHub repositories in the cloud',
    },
  ]
}

export default function Home() {
  return (
    <Box>
      {/* Header */}
      <Box
        component="header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          borderBottom: '1px solid var(--mantine-color-default-border)',
          backgroundColor: 'var(--mantine-color-body)',
        }}
      >
        <Container size="lg">
          <Group h={60} justify="space-between">
            <Group gap="xs">
              <IconGitBranch size={24} />
              <Anchor component={Link} to="/" underline="never" c="inherit">
                <Title order={4}>Multitool Workflow</Title>
              </Anchor>
            </Group>

            <Button
              component={Link}
              to="/auth/github"
              leftSection={<IconBrandGithub size={18} />}
            >
              Sign in with GitHub
            </Button>
          </Group>
        </Container>
      </Box>

      {/* Hero Section */}
      <Box component="main">
        <Container size="lg" py={{ base: 60, md: 100 }}>
          <Stack align="center" gap="lg" ta="center">
            <Title order={1} size="3rem" maw={800}>
              AI-Assisted Workflows
              <br />
              for Your GitHub Repositories
            </Title>
            <Text size="xl" c="dimmed" maw={600}>
              Run powerful AI workflows on any GitHub repository. Automate code
              reviews, generate documentation, refactor code, and more - all
              from a simple web interface.
            </Text>
            <Group mt="md">
              <Button
                size="lg"
                component={Link}
                to="/auth/github"
                leftSection={<IconBrandGithub size={20} />}
              >
                Get Started
              </Button>
              <Button
                size="lg"
                variant="outline"
                component={Link}
                to="/design-system"
              >
                View Components
              </Button>
            </Group>
          </Stack>
        </Container>

        {/* Features Section */}
        <Container size="lg" py={{ base: 40, md: 80 }}>
          <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
            <Card shadow="sm" padding="lg" radius="md" withBorder>
              <IconBrandGithub size={40} color="var(--mantine-primary-color-filled)" />
              <Title order={3} mt="md" mb="xs">
                GitHub Integration
              </Title>
              <Text c="dimmed" size="sm">
                Seamlessly connect to your GitHub repositories with OAuth.
                Select any repo, issue, or branch to run workflows on.
              </Text>
            </Card>

            <Card shadow="sm" padding="lg" radius="md" withBorder>
              <IconGitBranch size={40} color="var(--mantine-primary-color-filled)" />
              <Title order={3} mt="md" mb="xs">
                AI-Powered Workflows
              </Title>
              <Text c="dimmed" size="sm">
                Leverage Claude and other AI models to automate complex
                development tasks. Review code, fix bugs, and more.
              </Text>
            </Card>

            <Card shadow="sm" padding="lg" radius="md" withBorder>
              <IconCloud size={40} color="var(--mantine-primary-color-filled)" />
              <Title order={3} mt="md" mb="xs">
                Cloud-Based
              </Title>
              <Text c="dimmed" size="sm">
                Run workflows in the cloud without any local setup. Access
                your workflow history and results from anywhere.
              </Text>
            </Card>
          </SimpleGrid>
        </Container>

        {/* Security Section */}
        <Box
          style={{
            borderTop: '1px solid var(--mantine-color-default-border)',
            backgroundColor: 'var(--mantine-color-gray-light)',
          }}
        >
          <Container size="lg" py={{ base: 40, md: 80 }}>
            <Stack align="center" gap="md" ta="center" maw={600} mx="auto">
              <IconShield size={48} color="var(--mantine-primary-color-filled)" />
              <Title order={2}>Security First</Title>
              <Text c="dimmed">
                Your data is protected with industry-standard security
                practices. OAuth authentication, signed server-side sessions, and secure
                secret management ensure your credentials are always safe.
              </Text>
            </Stack>
          </Container>
        </Box>
      </Box>

      {/* Footer */}
      <Box
        component="footer"
        py="lg"
        style={{
          borderTop: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <Container size="lg">
          <Text size="sm" c="dimmed" ta="center">
            Built with React Router, Mantine, and Google Cloud.
          </Text>
        </Container>
      </Box>
    </Box>
  )
}
