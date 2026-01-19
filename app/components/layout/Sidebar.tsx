import { NavLink, Stack } from '@mantine/core'
import {
  IconHistory,
  IconLayoutDashboard,
  IconPlus,
  IconSettings,
} from '@tabler/icons-react'
import { Link, useLocation } from 'react-router'

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: IconLayoutDashboard, disabled: false },
  // The following routes will be implemented in Parts 2-3
  { name: 'New Workflow', href: '/workflow/new', icon: IconPlus, disabled: true },
  { name: 'History', href: '/history', icon: IconHistory, disabled: true },
  { name: 'Settings', href: '/settings', icon: IconSettings, disabled: true },
]

export function Sidebar() {
  const location = useLocation()

  return (
    <Stack gap="xs">
      {navigation.map((item) => {
        if (item.disabled) {
          return (
            <NavLink
              key={item.name}
              label={item.name}
              leftSection={<item.icon size={18} />}
              active={location.pathname === item.href}
              disabled
              variant="filled"
            />
          )
        }
        return (
          <NavLink
            key={item.name}
            component={Link}
            to={item.href}
            label={item.name}
            leftSection={<item.icon size={18} />}
            active={location.pathname === item.href}
            variant="filled"
          />
        )
      })}
    </Stack>
  )
}
