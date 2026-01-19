import type { Route } from './+types/auth.logout'
import { redirect } from 'react-router'
import { revokeSession } from '~/models/session.server'
import { destroySession, getSession } from '~/services/session.server'

/**
 * Logout route.
 *
 * This route handles user logout by:
 * 1. Revoking the session in Firestore (security: revoke first)
 * 2. Destroying the session cookie
 * 3. Redirecting to the home page
 *
 * Uses POST action to prevent logout CSRF attacks.
 */
export async function action({ request }: Route.ActionArgs) {
  const session = await getSession(request)

  if (session) {
    const sessionId = session.get('sessionId')

    // Revoke the session in Firestore if it exists (security: revoke first)
    if (sessionId) {
      try {
        await revokeSession(sessionId)
      }
      catch (error) {
        // Log but don't fail - the cookie will still be destroyed
        // Note: If Firestore was temporarily failing, the session remains valid server-side
        // but the user loses their cookie. This is acceptable for logout.
        console.error('Failed to revoke session:', error instanceof Error ? error.message : 'Unknown error')
      }
    }

    // Destroy the session cookie
    return redirect('/', {
      headers: {
        'Set-Cookie': await destroySession(session),
      },
    })
  }

  return redirect('/')
}

// Render nothing - this route is accessed via form submission
export default function AuthLogout() {
  return null
}
