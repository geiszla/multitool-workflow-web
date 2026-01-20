/**
 * Firebase Token API Endpoint.
 *
 * Generates a custom Firebase token for authenticated users.
 * This token is used by the Firebase client SDK to authenticate
 * and enable Firestore realtime subscriptions.
 *
 * Security:
 * - Requires valid session
 * - Token UID matches internal user ID
 */

import type { Route } from './+types/api.auth.firebase-token'
import { createCustomToken } from '~/services/firebase-admin.server'
import { requireUser } from '~/services/session.server'

/**
 * Helper to create JSON responses.
 */
function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init)
}

export async function loader({ request }: Route.LoaderArgs) {
  // Require authenticated user
  const user = await requireUser(request)

  try {
    // Generate custom token with user ID as UID
    const token = await createCustomToken(user.id)

    // Return with Cache-Control header to prevent caching of auth token
    return json({ token }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      },
    })
  }
  catch (error) {
    console.error('Failed to generate Firebase token:', error instanceof Error ? error.message : 'Unknown error')
    return json({ error: 'Failed to generate token' }, { status: 500 })
  }
}

// Only GET is allowed
export function action() {
  return json({ error: 'Method not allowed' }, { status: 405 })
}

// No UI for API routes
export default function FirebaseTokenApi() {
  return null
}
