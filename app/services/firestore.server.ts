/**
 * Firestore client singleton.
 *
 * This module provides a singleton Firestore client to avoid
 * re-initialization costs on each request.
 *
 * Features:
 * - Lazy initialization
 * - Singleton pattern
 * - Emulator support for local development
 * - Connection error handling
 */

import { Firestore } from '@google-cloud/firestore'

import { GCP_PROJECT_ID, isFirestoreEmulatorEnabled } from './env.server'

// Singleton Firestore instance
let firestoreInstance: Firestore | null = null

/**
 * Gets the Firestore client singleton.
 * Creates a new instance if one doesn't exist.
 */
export function getFirestore(): Firestore {
  if (!firestoreInstance) {
    firestoreInstance = new Firestore({
      projectId: GCP_PROJECT_ID,
      // The client will automatically use FIRESTORE_EMULATOR_HOST if set
    })

    // Log emulator status for debugging
    if (isFirestoreEmulatorEnabled()) {
      // eslint-disable-next-line no-console
      console.log(
        `Firestore: Connected to emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`,
      )
    }
  }

  return firestoreInstance
}

/**
 * Tests the Firestore connection.
 * Useful for health checks and startup validation.
 */
export async function testFirestoreConnection(): Promise<boolean> {
  try {
    const db = getFirestore()
    // Perform a simple read operation to verify connectivity
    await db.collection('_health').doc('ping').get()
    return true
  }
  catch (error) {
    console.error('Firestore connection test failed:', error instanceof Error ? error.message : 'Unknown error')
    return false
  }
}

/**
 * Firestore index configuration documentation.
 *
 * The following composite indexes should be created in Firestore:
 *
 * 1. Sessions collection - for cleanup and user lookup:
 *    Collection: sessions
 *    Fields:
 *      - userId (Ascending)
 *      - revokedAt (Ascending)
 *
 *    Collection: sessions
 *    Fields:
 *      - expiresAt (Ascending)
 *
 * These indexes can be created manually in the Firebase Console or via
 * the Firebase CLI using firestore.indexes.json.
 *
 * Firestore TTL Policy:
 * Consider enabling a TTL policy on the sessions collection using the
 * `expiresAt` field for automatic cleanup of expired sessions.
 * This can be configured in the Firebase Console under:
 * Firestore > TTL Policies > Add Policy
 *
 * @see https://cloud.google.com/firestore/docs/ttl
 */
export const FIRESTORE_INDEXES = {
  sessions: [
    {
      fields: [
        { fieldPath: 'userId', order: 'ASCENDING' },
        { fieldPath: 'revokedAt', order: 'ASCENDING' },
      ],
    },
    {
      fields: [{ fieldPath: 'expiresAt', order: 'ASCENDING' }],
    },
  ],
}
