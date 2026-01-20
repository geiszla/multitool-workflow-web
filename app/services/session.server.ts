/**
 * Session management service.
 *
 * This module handles user session management including:
 * - Session cookie creation and validation
 * - User authentication state
 * - Session expiry and cleanup
 *
 * Sessions are stored in Firestore. The cookie contains:
 * - sessionId: The Firestore session document ID
 *
 * User data is fetched from Firestore on each authenticated request to avoid
 * storing profile data in the cookie.
 *
 * Security: FAIL CLOSED - If Firestore is unavailable, redirect to login.
 */

import { createCookieSessionStorage, redirect } from 'react-router'
import {
  createSession as createFirestoreSession,
  getSession as getFirestoreSession,
} from '~/models/session.server'
import { getUserById } from '~/models/user.server'
import { getSecret } from './secrets.server'

// Session cookie configuration
const SESSION_MAX_AGE = 60 * 60 * 24 * 30 // 30 days in seconds

// User type for session data
export interface SessionUser {
  id: string // Internal user UUID
  githubLogin: string
  name?: string
  avatarUrl: string
  email?: string
  isComped?: boolean // True if using organization API keys
}

// Session data structure
interface SessionData {
  sessionId: string
}

// Flash data structure (for one-time messages)
interface SessionFlashData {
  error: string
}

// Type for our session storage
type AppSessionStorage = ReturnType<
  typeof createCookieSessionStorage<SessionData, SessionFlashData>
>

// Lazy initialization of session storage
// Note: We cache successful initialization but NOT failures, allowing retry on next request
let sessionStorageCache: AppSessionStorage | null = null
let sessionStorageInitialized = false

async function getSessionStorage(): Promise<AppSessionStorage | null> {
  // Return cached storage if already successfully initialized
  if (sessionStorageInitialized) {
    return sessionStorageCache
  }

  try {
    const sessionSecret = await getSecret('session-secret')

    sessionStorageCache = createCookieSessionStorage<SessionData, SessionFlashData>({
      cookie: {
        name: '__session',
        httpOnly: true,
        maxAge: SESSION_MAX_AGE,
        path: '/',
        sameSite: 'lax',
        secrets: [sessionSecret],
        secure: process.env.NODE_ENV === 'production',
      },
    })
    sessionStorageInitialized = true
    return sessionStorageCache
  }
  catch (error) {
    // Log but don't cache failure - allow retry on next request
    console.warn(
      'Session storage initialization failed - will retry on next request:',
      error instanceof Error ? error.message : 'Unknown error',
    )
    return null
  }
}

/**
 * Gets the session from the request.
 */
export async function getSession(request: Request) {
  const sessionStorage = await getSessionStorage()
  if (!sessionStorage)
    return null

  const cookie = request.headers.get('Cookie')
  return sessionStorage.getSession(cookie)
}

/**
 * Commits the session and returns the Set-Cookie header.
 */
export async function commitSession(
  session: Awaited<ReturnType<typeof getSession>>,
) {
  const sessionStorage = await getSessionStorage()
  if (!sessionStorage || !session)
    return ''

  return sessionStorage.commitSession(session)
}

/**
 * Destroys the session and returns the Set-Cookie header.
 */
export async function destroySession(
  session: Awaited<ReturnType<typeof getSession>>,
) {
  const sessionStorage = await getSessionStorage()
  if (!sessionStorage || !session)
    return ''

  return sessionStorage.destroySession(session)
}

/**
 * Gets the current session user from the request.
 * Returns null if not authenticated.
 *
 * SECURITY: FAIL CLOSED - If Firestore validation fails, return null (not authenticated).
 * This ensures that if Firestore is unavailable, the user is forced to re-authenticate
 * rather than potentially accessing resources without proper validation.
 */
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  const session = await getSession(request)
  if (!session)
    return null

  const sessionId = session.get('sessionId')
  if (!sessionId)
    return null

  // FAIL CLOSED: Validate session exists in Firestore and is not expired/revoked
  // If Firestore is unavailable or validation fails, return null
  try {
    const firestoreSession = await getFirestoreSession(sessionId)
    if (!firestoreSession) {
      // Session no longer valid in Firestore
      return null
    }

    const user = await getUserById(firestoreSession.userId)
    if (!user)
      return null

    return {
      id: firestoreSession.userId,
      githubLogin: user.githubLogin,
      name: user.name,
      avatarUrl: user.avatarUrl,
      email: user.email,
      isComped: user.isComped,
    }
  }
  catch (error) {
    // FAIL CLOSED: If Firestore is unavailable, treat as unauthenticated
    console.error('Failed to validate session against Firestore:', error instanceof Error ? error.message : 'Unknown error')
    return null
  }
}

/**
 * Requires the user to be authenticated.
 * Throws a redirect to login if not authenticated.
 * Also clears any stale session cookies to avoid repeated validation failures.
 *
 * SECURITY: FAIL CLOSED - If Firestore is unavailable, redirect to login.
 */
export async function requireUser(request: Request): Promise<SessionUser> {
  const session = await getSession(request)
  if (!session) {
    // Session storage not available - redirect to login
    const url = new URL(request.url)
    const returnTo = encodeURIComponent(url.pathname + url.search)
    throw redirect(`/auth/github?returnTo=${returnTo}`)
  }

  const sessionId = session.get('sessionId')
  if (!sessionId) {
    // No session cookie at all
    const url = new URL(request.url)
    const returnTo = encodeURIComponent(url.pathname + url.search)
    throw redirect(`/auth/github?returnTo=${returnTo}`)
  }

  // FAIL CLOSED: Validate session exists in Firestore and is not expired/revoked
  // If Firestore is unavailable or validation fails, redirect to login
  try {
    const firestoreSession = await getFirestoreSession(sessionId)
    if (!firestoreSession) {
      // Session no longer valid in Firestore - clear stale cookie
      const url = new URL(request.url)
      const returnTo = encodeURIComponent(url.pathname + url.search)
      throw redirect(`/auth/github?returnTo=${returnTo}`, {
        headers: {
          'Set-Cookie': await destroySession(session),
        },
      })
    }

    const user = await getUserById(firestoreSession.userId)
    if (!user) {
      const url = new URL(request.url)
      const returnTo = encodeURIComponent(url.pathname + url.search)
      throw redirect(`/auth/github?returnTo=${returnTo}`, {
        headers: {
          'Set-Cookie': await destroySession(session),
        },
      })
    }

    return {
      id: firestoreSession.userId,
      githubLogin: user.githubLogin,
      name: user.name,
      avatarUrl: user.avatarUrl,
      email: user.email,
      isComped: user.isComped,
    }
  }
  catch (error) {
    // If it's already a redirect Response, rethrow it
    if (error instanceof Response) {
      throw error
    }
    // FAIL CLOSED: If Firestore is unavailable, treat as unauthenticated
    console.error('Failed to validate session against Firestore:', error instanceof Error ? error.message : 'Unknown error')
    const url = new URL(request.url)
    const returnTo = encodeURIComponent(url.pathname + url.search)
    throw redirect(`/auth/github?returnTo=${returnTo}`, {
      headers: {
        'Set-Cookie': await destroySession(session),
      },
    })
  }
}

/**
 * Requires the user's ID to be authenticated.
 * Throws a redirect to login if not authenticated.
 */
export async function requireUserId(request: Request): Promise<string> {
  const user = await requireUser(request)
  return user.id
}

/**
 * Creates a new session for the user.
 */
export async function createUserSession({
  request,
  userId,
  redirectTo,
}: {
  request: Request
  userId: string
  redirectTo: string
}) {
  const session = await getSession(request)
  if (!session) {
    throw new Error('Session storage not available')
  }

  // Create session in Firestore and get the sessionId
  const sessionId = await createFirestoreSession(userId)

  session.set('sessionId', sessionId)

  return redirect(redirectTo, {
    headers: {
      'Set-Cookie': await commitSession(session),
    },
  })
}
