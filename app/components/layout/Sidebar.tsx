import { NavLink, Stack } from '@mantine/core'
import {
  IconRobot,
  IconSettings,
} from '@tabler/icons-react'
import { Link, useLocation } from 'react-router'

const navigation = [
  { name: 'Agents', href: '/agents', icon: IconRobot },
  { name: 'Settings', href: '/settings', icon: IconSettings },
]

export function Sidebar() {
  const location = useLocation()

  return (
    <Stack gap="xs">
      {navigation.map(item => (
        <NavLink
          key={item.name}
          component={Link}
          to={item.href}
          label={item.name}
          leftSection={<item.icon size={18} />}
          active={location.pathname === item.href || location.pathname.startsWith(`${item.href}/`)}
          variant="filled"
        />
      ))}
    </Stack>
  )
}
