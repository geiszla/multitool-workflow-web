import type { Route } from './+types/_app'
import { AppShell } from '@mantine/core'
import { Outlet, useLoaderData } from 'react-router'
import { Header } from '~/components/layout/Header'
import { Sidebar } from '~/components/layout/Sidebar'
import { requireUser } from '~/services/session.server'

/**
 * Loader for authenticated routes.
 * Redirects to login if user is not authenticated.
 * Clears stale session cookies to avoid repeated validation failures.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request)
  return { user }
}

export default function AppLayout() {
  const { user } = useLoaderData<typeof loader>()

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 250, breakpoint: 'sm' }}
      padding="md"
    >
      <AppShell.Header>
        <Header user={user} />
      </AppShell.Header>

      <AppShell.Navbar p="md">
        <Sidebar />
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
