import {
  ActionIcon,
  Button,
  Group,
  PasswordInput,
  Stack,
  Text,
} from '@mantine/core'
import { IconCheck, IconEye, IconEyeOff, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'

interface ApiKeyInputProps {
  /** Tool name for identification */
  toolName: string
  /** Label for the input */
  label: string
  /** Placeholder text */
  placeholder?: string
  /** Whether a key is currently configured */
  isConfigured: boolean
  /** Last 4 characters of the configured key (for display) */
  keySuffix?: string | null
  /** Whether save/delete operations are in progress */
  isLoading?: boolean
  /** Called when save is clicked with the new key */
  onSave: (key: string) => void
  /** Called when delete is clicked */
  onDelete: () => void
}

export function ApiKeyInput({
  toolName,
  label,
  placeholder = 'Enter API key...',
  isConfigured,
  keySuffix,
  isLoading = false,
  onSave,
  onDelete,
}: ApiKeyInputProps) {
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [isEditing, setIsEditing] = useState(!isConfigured)

  const handleSave = () => {
    if (value.trim()) {
      onSave(value.trim())
      setValue('')
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    onDelete()
    setValue('')
    setIsEditing(true)
  }

  const handleCancel = () => {
    setValue('')
    setIsEditing(false)
  }

  if (isConfigured && !isEditing) {
    return (
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <IconCheck size={16} color="var(--mantine-color-green-6)" />
            <Text size="sm" c="dimmed">
              Configured
              {keySuffix && (
                <Text span c="dimmed" size="xs" ml="xs">
                  (ending in ...
                  {keySuffix}
                  )
                </Text>
              )}
            </Text>
          </Group>
          <Group gap="xs">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => setIsEditing(true)}
              disabled={isLoading}
            >
              Update
            </Button>
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={handleDelete}
              loading={isLoading}
              aria-label={`Delete ${toolName} API key`}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        </Group>
      </Stack>
    )
  }

  return (
    <Stack gap="xs">
      <PasswordInput
        label={label}
        placeholder={placeholder}
        value={value}
        onChange={e => setValue(e.currentTarget.value)}
        visible={visible}
        onVisibilityChange={setVisible}
        visibilityToggleIcon={({ reveal }) =>
          reveal
            ? <IconEyeOff size={16} />
            : <IconEye size={16} />}
        disabled={isLoading}
        rightSectionWidth={isConfigured ? 120 : 80}
        rightSection={(
          <Group gap="xs" wrap="nowrap">
            {isConfigured && (
              <Button
                variant="subtle"
                size="xs"
                onClick={handleCancel}
                disabled={isLoading}
              >
                Cancel
              </Button>
            )}
            <Button
              size="xs"
              onClick={handleSave}
              loading={isLoading}
              disabled={!value.trim()}
            >
              Save
            </Button>
          </Group>
        )}
      />
    </Stack>
  )
}
