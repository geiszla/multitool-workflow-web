/**
 * Finish Modal Component.
 *
 * Confirms the user's intent to instruct the agent to complete its work:
 * - Run Codex code review
 * - Commit and push changes to a new branch
 * - Create a pull request
 */

import {
  Alert,
  Button,
  Group,
  List,
  Modal,
  Stack,
  Text,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconGitPullRequest,
} from '@tabler/icons-react'

interface FinishModalProps {
  opened: boolean
  onClose: () => void
  onConfirm: () => void
  isLoading: boolean
  error?: string
}

export function FinishModal({
  opened,
  onClose,
  onConfirm,
  isLoading,
  error,
}: FinishModalProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Finish Agent Work"
      centered
      size="md"
    >
      <Stack gap="md">
        <Text>
          This will instruct the agent to complete its work and prepare a pull request.
          The agent will:
        </Text>

        <List spacing="xs" size="sm" withPadding>
          <List.Item>Run a Codex code review on all changes</List.Item>
          <List.Item>Address any critical issues from the review</List.Item>
          <List.Item>Commit all local changes</List.Item>
          <List.Item>Push to a new branch</List.Item>
          <List.Item>Create a pull request</List.Item>
        </List>

        <Alert
          icon={<IconAlertCircle size={16} />}
          color="yellow"
          variant="light"
        >
          The agent will continue working autonomously after you confirm.
          You can monitor progress in the terminal.
        </Alert>

        {error && (
          <Alert
            icon={<IconAlertCircle size={16} />}
            title="Error"
            color="red"
          >
            {error}
          </Alert>
        )}

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            color="green"
            leftSection={<IconGitPullRequest size={16} />}
            onClick={onConfirm}
            loading={isLoading}
          >
            Start Finish Process
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
