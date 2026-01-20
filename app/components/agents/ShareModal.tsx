/**
 * Share Modal Component.
 *
 * Allows the agent owner to share access with other users by their GitHub username.
 * Users must have logged in at least once to be added.
 */

import type { User } from '~/models/user.server'
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconTrash,
  IconUserPlus,
} from '@tabler/icons-react'
import { useState } from 'react'
import { useFetcher } from 'react-router'

interface ShareModalProps {
  opened: boolean
  onClose: () => void
  agentId: string
  agentTitle: string
  sharedUsers: Array<Pick<User, 'id' | 'githubLogin' | 'avatarUrl'>>
}

interface ShareActionData {
  success?: boolean
  error?: string
  sharedUsers?: Array<Pick<User, 'id' | 'githubLogin' | 'avatarUrl'>>
}

export function ShareModal({
  opened,
  onClose,
  agentId: _agentId,
  agentTitle,
  sharedUsers,
}: ShareModalProps) {
  const [githubLogin, setGithubLogin] = useState('')
  const fetcher = useFetcher<ShareActionData>()

  const isLoading = fetcher.state !== 'idle'
  const error = fetcher.data?.error

  const handleShare = () => {
    if (!githubLogin.trim()) {
      return
    }

    fetcher.submit(
      { intent: 'share', githubLogin: githubLogin.trim() },
      { method: 'post' },
    )

    // Clear input on submit
    setGithubLogin('')
  }

  const handleUnshare = (userId: string) => {
    fetcher.submit(
      { intent: 'unshare', unshareUserId: userId },
      { method: 'post' },
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleShare()
    }
  }

  // Use updated shared users from fetcher response if available
  const displayedUsers = fetcher.data?.sharedUsers ?? sharedUsers

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Share Agent"
      centered
      size="md"
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Share
          {' '}
          <strong>{agentTitle}</strong>
          {' '}
          with other users. Shared users will have full access to view and control this agent.
        </Text>

        {/* Error alert */}
        {error && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            title="Error"
            color="red"
            withCloseButton
          >
            {error}
          </Alert>
        )}

        {/* Add user form */}
        <Group align="flex-end">
          <TextInput
            label="GitHub Username"
            placeholder="username"
            value={githubLogin}
            onChange={e => setGithubLogin(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{ flex: 1 }}
            disabled={isLoading}
          />
          <Button
            leftSection={<IconUserPlus size={16} />}
            onClick={handleShare}
            loading={isLoading && fetcher.formData?.get('intent') === 'share'}
            disabled={!githubLogin.trim()}
          >
            Add
          </Button>
        </Group>

        <Text size="xs" c="dimmed">
          The user must have logged in at least once before they can be added.
        </Text>

        {/* Shared users list */}
        {displayedUsers.length > 0 && (
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              Shared with
            </Text>
            {displayedUsers.map(user => (
              <Group key={user.id} justify="space-between" py="xs">
                <Group gap="xs">
                  <img
                    src={user.avatarUrl}
                    alt={user.githubLogin}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                    }}
                  />
                  <Text size="sm">{user.githubLogin}</Text>
                </Group>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => handleUnshare(user.id)}
                  loading={isLoading && fetcher.formData?.get('unshareUserId') === user.id}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}

        {displayedUsers.length === 0 && (
          <Text size="sm" c="dimmed" ta="center" py="md">
            Not shared with anyone yet.
          </Text>
        )}

        {/* Close button */}
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose}>
            Done
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
