/**
 * Session data model and Firestore operations.
 *
 * Sessions are stored in Firestore with a randomly generated session ID.
 * The session cookie contains the session ID and cached user data.
 * Firestore is the source of truth for session validity (expiry, revocation).
 *
 * Performance: lastSeenAt updates are throttled to reduce Firestore writes.
 */

import { Timestamp } from '@google-cloud/firestore'
import { getFirestore } from '~/services/firestore.server'

/**
 * Session document structure in Firestore.
 */
export interface Session {
  userId: string
  createdAt: Timestamp
  expiresAt: Timestamp
  revokedAt: Timestamp | null
  lastSeenAt: Timestamp
}

const SESSIONS_COLLECTION = 'sessions'

// Session TTL: 30 days in milliseconds
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

// Throttle lastSeenAt updates: only update if older than 5 minutes
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000

/**
 * Creates a new session in Firestore.
 * Returns the session ID.
 */
export async function createSession(userId: string): Promise<string> {
  const db = getFirestore()
  const sessionId = crypto.randomUUID()
  const now = Timestamp.now()
  const expiresAt = Timestamp.fromMillis(now.toMillis() + SESSION_TTL_MS)

  const session: Session = {
    userId,
    createdAt: now,
    expiresAt,
    revokedAt: null,
    lastSeenAt: now,
  }

  await db.collection(SESSIONS_COLLECTION).doc(sessionId).set(session)

  return sessionId
}

/**
 * Gets a session by ID.
 * Returns null if the session doesn't exist, is expired, or is revoked.
 *
 * Performance: lastSeenAt is only updated if older than 5 minutes to reduce writes.
 */
export async function getSession(
  sessionId: string,
): Promise<{ session: Session, userId: string } | null> {
  const db = getFirestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const doc = await sessionRef.get()

  if (!doc.exists) {
    return null
  }

  const session = doc.data() as Session

  // Check if session is revoked
  if (session.revokedAt) {
    return null
  }

  // Check if session is expired
  if (session.expiresAt.toMillis() < Date.now()) {
    return null
  }

  // Throttle lastSeenAt updates: only update if older than 5 minutes
  const now = Date.now()
  const lastSeenAge = now - session.lastSeenAt.toMillis()

  if (lastSeenAge > LAST_SEEN_THROTTLE_MS) {
    // Update last seen time (fire and forget)
    sessionRef.update({ lastSeenAt: Timestamp.now() }).catch(() => {
      // Ignore errors - this is a best-effort update
    })
  }

  return { session, userId: session.userId }
}

/**
 * Revokes a session by ID.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  const db = getFirestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)

  await sessionRef.update({
    revokedAt: Timestamp.now(),
  })
}

/**
 * Revokes all sessions for a user.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  const db = getFirestore()
  const now = Timestamp.now()

  const snapshot = await db
    .collection(SESSIONS_COLLECTION)
    .where('userId', '==', userId)
    .where('revokedAt', '==', null)
    .get()

  const batch = db.batch()
  snapshot.docs.forEach((doc) => {
    batch.update(doc.ref, { revokedAt: now })
  })

  await batch.commit()
}

/**
 * Cleans up expired sessions.
 * This should be called periodically (e.g., via a Cloud Function or cron job).
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const db = getFirestore()
  const now = Timestamp.now()

  const snapshot = await db
    .collection(SESSIONS_COLLECTION)
    .where('expiresAt', '<', now)
    .limit(500) // Process in batches
    .get()

  if (snapshot.empty) {
    return 0
  }

  const batch = db.batch()
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref)
  })

  await batch.commit()

  return snapshot.size
}
