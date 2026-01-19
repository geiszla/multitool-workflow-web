import {
  Avatar,
  Button,
  Group,
  Menu,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core'
import {
  IconLogout,
  IconRobot,
  IconSettings,
} from '@tabler/icons-react'
import { Form, Link } from 'react-router'

interface HeaderProps {
  user?: {
    name?: string
    avatarUrl: string
    githubLogin: string
  } | null
}

export function Header({ user }: HeaderProps) {
  return (
    <Group h="100%" px="md" justify="space-between">
      <UnstyledButton component={Link} to="/">
        <Title order={4}>Multitool Workflow</Title>
      </UnstyledButton>

      <Group>
        {user
          ? (
              <Menu shadow="md" width={200} position="bottom-end">
                <Menu.Target>
                  <UnstyledButton>
                    <Avatar
                      src={user.avatarUrl}
                      alt={user.name || user.githubLogin}
                      radius="xl"
                      size="md"
                    />
                  </UnstyledButton>
                </Menu.Target>

                <Menu.Dropdown>
                  <Menu.Label>
                    <Text size="sm" fw={500}>
                      {user.name || user.githubLogin}
                    </Text>
                    <Text size="xs" c="dimmed">
                      @
                      {user.githubLogin}
                    </Text>
                  </Menu.Label>

                  <Menu.Divider />

                  <Menu.Item
                    leftSection={<IconRobot size={16} />}
                    component={Link}
                    to="/agents"
                  >
                    Agents
                  </Menu.Item>

                  <Menu.Item
                    leftSection={<IconSettings size={16} />}
                    component={Link}
                    to="/settings"
                  >
                    Settings
                  </Menu.Item>

                  <Menu.Divider />

                  <Form action="/auth/logout" method="post">
                    <Menu.Item
                      leftSection={<IconLogout size={16} />}
                      component="button"
                      type="submit"
                      color="red"
                      style={{ width: '100%' }}
                    >
                      Log out
                    </Menu.Item>
                  </Form>
                </Menu.Dropdown>
              </Menu>
            )
          : (
              <Button component={Link} to="/auth/github">
                Sign in with GitHub
              </Button>
            )}
      </Group>
    </Group>
  )
}
