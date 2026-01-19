/**
 * User data model and Firestore operations.
 *
 * Users are stored in Firestore with an internal UUID as the document ID.
 * This allows supporting multiple authentication providers in the future.
 *
 * Migration: Existing users using GitHub ID as document ID will be migrated
 * on their next login (lazy migration).
 */

import { Timestamp } from '@google-cloud/firestore'
import { getFirestore } from '~/services/firestore.server'

/**
 * User document structure in Firestore.
 */
export interface User {
  id: string // Internal UUID (same as document ID)
  githubId: string // GitHub user ID (for OAuth reference)
  githubLogin: string
  name?: string
  email?: string
  avatarUrl: string
  createdAt: Timestamp
  updatedAt: Timestamp
  lastLoginAt: Timestamp
}

/**
 * Input for creating or updating a user.
 */
export interface UpsertUserInput {
  githubId: string // GitHub user ID
  githubLogin: string
  name: string | null
  email: string | null
  avatarUrl: string
}

const USERS_COLLECTION = 'users'

/**
 * Creates or updates a user in Firestore.
 *
 * For new users: Creates with a new internal UUID.
 * For existing users: Looks up by githubId, migrates if needed (old doc used GitHub ID as doc ID).
 *
 * Returns the internal user ID (UUID).
 */
export async function upsertUser(input: UpsertUserInput): Promise<string> {
  const db = getFirestore()
  const now = Timestamp.now()

  // First, try to find existing user by githubId
  const existingUser = await getUserByGitHubId(input.githubId)

  if (existingUser) {
    // Update existing user
    const userRef = db.collection(USERS_COLLECTION).doc(existingUser.id)
    await userRef.update({
      githubLogin: input.githubLogin,
      name: input.name ?? undefined,
      email: input.email ?? undefined,
      avatarUrl: input.avatarUrl,
      updatedAt: now,
      lastLoginAt: now,
    })
    return existingUser.id
  }

  // Check for legacy user (document ID is GitHub ID instead of UUID)
  // This handles migration from the old data model
  const legacyUserRef = db.collection(USERS_COLLECTION).doc(input.githubId)
  const legacyDoc = await legacyUserRef.get()

  if (legacyDoc.exists) {
    // Migrate legacy user to new schema
    const legacyData = legacyDoc.data()!
    const newUserId = crypto.randomUUID()

    const migratedUser: User = {
      id: newUserId,
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      name: input.name ?? undefined,
      email: input.email ?? undefined,
      avatarUrl: input.avatarUrl,
      createdAt: legacyData.createdAt as Timestamp,
      updatedAt: now,
      lastLoginAt: now,
    }

    // Create new document with UUID, delete legacy document
    // Use batch for atomicity
    const batch = db.batch()
    batch.set(db.collection(USERS_COLLECTION).doc(newUserId), migratedUser)
    batch.delete(legacyUserRef)
    await batch.commit()

    // eslint-disable-next-line no-console
    console.log(`Migrated user ${input.githubLogin} from legacy doc ${input.githubId} to ${newUserId}`)
    return newUserId
  }

  // Create new user with UUID
  const newUserId = crypto.randomUUID()
  const user: User = {
    id: newUserId,
    githubId: input.githubId,
    githubLogin: input.githubLogin,
    name: input.name ?? undefined,
    email: input.email ?? undefined,
    avatarUrl: input.avatarUrl,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  }

  await db.collection(USERS_COLLECTION).doc(newUserId).set(user)
  return newUserId
}

/**
 * Gets a user by their internal UUID.
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
 * Gets a user by their GitHub ID.
 * Uses an indexed query for efficient lookup.
 */
export async function getUserByGitHubId(
  githubId: string,
): Promise<User | null> {
  const db = getFirestore()
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where('githubId', '==', githubId)
    .limit(1)
    .get()

  if (snapshot.empty) {
    return null
  }

  return snapshot.docs[0].data() as User
}

/**
 * Gets a user by their GitHub login (username).
 */
export async function getUserByGitHubLogin(
  githubLogin: string,
): Promise<User | null> {
  const db = getFirestore()
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where('githubLogin', '==', githubLogin)
    .limit(1)
    .get()

  if (snapshot.empty) {
    return null
  }

  return snapshot.docs[0].data() as User
}
