import {
  Avatar,
  Box,
  Button,
  Card,
  ColorSwatch,
  Container,
  Divider,
  Group,
  Menu,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconChevronDown,
  IconLogout,
  IconSettings,
  IconUser,
} from '@tabler/icons-react'

export function meta() {
  return [
    { title: 'Design System - Multitool Workflow' },
    { name: 'description', content: 'Design system component showcase' },
  ]
}

export default function DesignSystem() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        <div>
          <Title order={1} mb="xs">
            Design System
          </Title>
          <Text c="dimmed">
            A showcase of all UI components available in the application.
          </Text>
        </div>

        <Divider />

        {/* Buttons Section */}
        <section>
          <Title order={2} mb="md">
            Buttons
          </Title>
          <Stack gap="md">
            <Group>
              <Button>Default</Button>
              <Button variant="light">Light</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="subtle">Subtle</Button>
              <Button variant="transparent">Transparent</Button>
            </Group>
            <Group>
              <Button color="red">Red</Button>
              <Button color="green">Green</Button>
              <Button color="blue">Blue</Button>
              <Button color="yellow">Yellow</Button>
            </Group>
            <Group>
              <Button size="xs">Extra Small</Button>
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
              <Button size="xl">Extra Large</Button>
            </Group>
            <Group>
              <Button disabled>Disabled</Button>
              <Button loading>Loading</Button>
            </Group>
          </Stack>
        </section>

        <Divider />

        {/* Cards Section */}
        <section>
          <Title order={2} mb="md">
            Cards
          </Title>
          <SimpleGrid cols={{ base: 1, md: 2, lg: 3 }}>
            <Card shadow="sm" padding="lg" radius="md" withBorder>
              <Title order={4} mb="xs">
                Card Title
              </Title>
              <Text size="sm" c="dimmed" mb="md">
                Card description goes here.
              </Text>
              <Text size="sm" mb="md">
                Card content with some text.
              </Text>
              <Button fullWidth>Action</Button>
            </Card>

            <Card shadow="sm" padding="lg" radius="md" withBorder>
              <Title order={4} mb="xs">
                Another Card
              </Title>
              <Text size="sm" c="dimmed" mb="md">
                With different content.
              </Text>
              <TextInput placeholder="Type something..." mb="md" />
              <Group>
                <Button variant="outline" flex={1}>
                  Cancel
                </Button>
                <Button flex={1}>Submit</Button>
              </Group>
            </Card>
          </SimpleGrid>
        </section>

        <Divider />

        {/* Inputs Section */}
        <section>
          <Title order={2} mb="md">
            Inputs
          </Title>
          <Box maw={400}>
            <Stack>
              <TextInput placeholder="Default input" />
              <TextInput type="email" placeholder="Email input" />
              <TextInput type="password" placeholder="Password input" />
              <TextInput disabled placeholder="Disabled input" />
              <TextInput error="This field has an error" placeholder="Error input" />
            </Stack>
          </Box>
        </section>

        <Divider />

        {/* Avatars Section */}
        <section>
          <Title order={2} mb="md">
            Avatars
          </Title>
          <Group>
            <Avatar
              src="https://github.com/shadcn.png"
              alt="@shadcn"
              radius="xl"
            />
            <Avatar radius="xl" color="blue">
              JD
            </Avatar>
            <Avatar radius="xl" color="green" size="lg">
              LG
            </Avatar>
            <Avatar radius="xl" color="red" size="sm">
              SM
            </Avatar>
          </Group>
        </section>

        <Divider />

        {/* Dropdown Menu Section */}
        <section>
          <Title order={2} mb="md">
            Menu
          </Title>
          <Group>
            <Menu shadow="md" width={200}>
              <Menu.Target>
                <Button rightSection={<IconChevronDown size={16} />}>
                  Open Menu
                </Button>
              </Menu.Target>

              <Menu.Dropdown>
                <Menu.Label>My Account</Menu.Label>
                <Menu.Item leftSection={<IconUser size={16} />}>
                  Profile
                </Menu.Item>
                <Menu.Item leftSection={<IconSettings size={16} />}>
                  Settings
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item leftSection={<IconLogout size={16} />} color="red">
                  Log out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </section>

        <Divider />

        {/* Typography Section */}
        <section>
          <Title order={2} mb="md">
            Typography
          </Title>
          <Stack gap="xs">
            <Title order={1}>Heading 1</Title>
            <Title order={2}>Heading 2</Title>
            <Title order={3}>Heading 3</Title>
            <Title order={4}>Heading 4</Title>
            <Text>Regular paragraph text.</Text>
            <Text c="dimmed">Muted text for secondary information.</Text>
            <Text size="xs">Small text</Text>
            <Text fw={700}>Bold text</Text>
            <Text fs="italic">Italic text</Text>
          </Stack>
        </section>

        <Divider />

        {/* Colors Section */}
        <section>
          <Title order={2} mb="md">
            Colors
          </Title>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-color-blue-filled)"
                size={80}
              />
              <Text size="sm">Blue</Text>
            </Stack>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-color-red-filled)"
                size={80}
              />
              <Text size="sm">Red</Text>
            </Stack>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-color-green-filled)"
                size={80}
              />
              <Text size="sm">Green</Text>
            </Stack>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-color-yellow-filled)"
                size={80}
              />
              <Text size="sm">Yellow</Text>
            </Stack>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-color-gray-filled)"
                size={80}
              />
              <Text size="sm">Gray</Text>
            </Stack>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-color-dark-filled)"
                size={80}
              />
              <Text size="sm">Dark</Text>
            </Stack>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-primary-color-filled)"
                size={80}
              />
              <Text size="sm">Primary</Text>
            </Stack>
            <Stack gap="xs" align="center">
              <ColorSwatch
                color="var(--mantine-color-body)"
                size={80}
                style={{ border: '1px solid var(--mantine-color-default-border)' }}
              />
              <Text size="sm">Body</Text>
            </Stack>
          </SimpleGrid>
        </section>
      </Stack>
    </Container>
  )
}
