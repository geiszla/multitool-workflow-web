/**
 * User data model and Firestore operations.
 *
 * Users are stored in Firestore with their GitHub ID as the document ID.
 */

import { Timestamp } from '@google-cloud/firestore'
import { getFirestore } from '~/services/firestore.server'

/**
 * User document structure in Firestore.
 */
export interface User {
  githubLogin: string
  name: string | null
  email: string | null
  avatarUrl: string
  createdAt: Timestamp
  updatedAt: Timestamp
  lastLoginAt: Timestamp
}

/**
 * Input for creating or updating a user.
 */
export interface UpsertUserInput {
  id: string
  githubLogin: string
  name: string | null
  email: string | null
  avatarUrl: string
}

const USERS_COLLECTION = 'users'

/**
 * Creates or updates a user in Firestore.
 * Uses the GitHub ID as the document ID.
 */
export async function upsertUser(input: UpsertUserInput): Promise<void> {
  const db = getFirestore()
  const userRef = db.collection(USERS_COLLECTION).doc(input.id)
  const now = Timestamp.now()

  const existingUser = await userRef.get()

  if (existingUser.exists) {
    // Update existing user
    await userRef.update({
      githubLogin: input.githubLogin,
      name: input.name,
      email: input.email,
      avatarUrl: input.avatarUrl,
      updatedAt: now,
      lastLoginAt: now,
    })
  }
  else {
    // Create new user
    const user: User = {
      githubLogin: input.githubLogin,
      name: input.name,
      email: input.email,
      avatarUrl: input.avatarUrl,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    }
    await userRef.set(user)
  }
}

/**
 * Gets a user by their GitHub ID.
 */
export async function getUserById(id: string): Promise<User | null> {
  const db = getFirestore()
  const userRef = db.collection(USERS_COLLECTION).doc(id)
  const doc = await userRef.get()

  if (!doc.exists) {
    return null
  }

  return doc.data() as User
}

/**
 * Gets a user by their GitHub login (username).
 */
export async function getUserByGitHubLogin(
  githubLogin: string,
): Promise<{ id: string, user: User } | null> {
  const db = getFirestore()
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where('githubLogin', '==', githubLogin)
    .limit(1)
    .get()

  if (snapshot.empty) {
    return null
  }

  const doc = snapshot.docs[0]
  return {
    id: doc.id,
    user: doc.data() as User,
  }
}
