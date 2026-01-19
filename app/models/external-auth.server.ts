/**
 * External Auth data model and Firestore operations.
 *
 * Stores encrypted API keys for external tools (Claude, Codex, GitHub) using
 * envelope encryption with Google Cloud KMS.
 *
 * Security properties:
 * - API keys are encrypted with user-specific AAD (prevents secret swapping)
 * - Plaintext is never stored or logged
 * - Each secret has its own unique DEK
 */

import type { AadContext, EncryptedEnvelope } from '~/services/kms.server'
import { Buffer } from 'node:buffer'
import { Timestamp } from '@google-cloud/firestore'
import { getFirestore } from '~/services/firestore.server'
import {
  decryptSecret,
  encryptSecret,
} from '~/services/kms.server'

/**
 * Supported external tools.
 */
export type ToolName = 'claude' | 'codex' | 'github'

/**
 * External auth document structure in Firestore.
 */
export interface ExternalAuth {
  userId: string // Internal user UUID
  toolName: ToolName // Tool identifier

  // Envelope encryption fields
  wrappedDek: string // Base64-encoded KMS-wrapped DEK
  iv: string // Base64-encoded AES-GCM IV (12 bytes)
  tag: string // Base64-encoded AES-GCM auth tag (16 bytes)
  ciphertext: string // Base64-encoded encrypted API key
  kmsKeyVersion: string // KMS key version used for wrapping

  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * External auth info returned to the UI (without sensitive data).
 */
export interface ExternalAuthInfo {
  toolName: ToolName
  createdAt: Timestamp
  updatedAt: Timestamp
}

const EXTERNAL_AUTH_COLLECTION = 'external_auth'

/**
 * Generates the document ID for an external auth record.
 * Format: `{userId}_{toolName}`
 */
function getDocumentId(userId: string, toolName: ToolName): string {
  return `${userId}_${toolName}`
}

/**
 * Creates the AAD context for envelope encryption.
 */
function getAadContext(userId: string, toolName: ToolName): AadContext {
  return { userId, toolName }
}

/**
 * Saves an external auth record with encrypted API key.
 *
 * @param userId - Internal user UUID
 * @param toolName - Tool identifier
 * @param apiKey - Plaintext API key to encrypt and store
 */
export async function saveExternalAuth(
  userId: string,
  toolName: ToolName,
  apiKey: string,
): Promise<void> {
  const db = getFirestore()
  const docId = getDocumentId(userId, toolName)
  const context = getAadContext(userId, toolName)
  const now = Timestamp.now()

  // Encrypt the API key
  const envelope = await encryptSecret(Buffer.from(apiKey, 'utf-8'), context)

  const externalAuth: ExternalAuth = {
    userId,
    toolName,
    wrappedDek: envelope.wrappedDek,
    iv: envelope.iv,
    tag: envelope.tag,
    ciphertext: envelope.ciphertext,
    kmsKeyVersion: envelope.kmsKeyVersion,
    createdAt: now,
    updatedAt: now,
  }

  // Check if document exists to preserve createdAt
  const existingDoc = await db.collection(EXTERNAL_AUTH_COLLECTION).doc(docId).get()
  if (existingDoc.exists) {
    const existingData = existingDoc.data() as ExternalAuth
    externalAuth.createdAt = existingData.createdAt
  }

  await db.collection(EXTERNAL_AUTH_COLLECTION).doc(docId).set(externalAuth)
}

/**
 * Retrieves and decrypts an external auth record.
 *
 * @param userId - Internal user UUID
 * @param toolName - Tool identifier
 * @returns Decrypted API key or null if not found
 */
export async function getExternalAuth(
  userId: string,
  toolName: ToolName,
): Promise<string | null> {
  const db = getFirestore()
  const docId = getDocumentId(userId, toolName)
  const doc = await db.collection(EXTERNAL_AUTH_COLLECTION).doc(docId).get()

  if (!doc.exists) {
    return null
  }

  const data = doc.data() as ExternalAuth

  // Verify userId matches (defense in depth)
  if (data.userId !== userId) {
    console.error(`External auth userId mismatch: expected ${userId}, got ${data.userId}`)
    return null
  }

  const context = getAadContext(userId, toolName)
  const envelope: EncryptedEnvelope = {
    wrappedDek: data.wrappedDek,
    iv: data.iv,
    tag: data.tag,
    ciphertext: data.ciphertext,
    kmsKeyVersion: data.kmsKeyVersion,
  }

  const plaintext = await decryptSecret(envelope, context)
  return plaintext.toString('utf-8')
}

/**
 * Deletes an external auth record.
 *
 * @param userId - Internal user UUID
 * @param toolName - Tool identifier
 */
export async function deleteExternalAuth(
  userId: string,
  toolName: ToolName,
): Promise<void> {
  const db = getFirestore()
  const docId = getDocumentId(userId, toolName)

  // Verify ownership before deletion
  const doc = await db.collection(EXTERNAL_AUTH_COLLECTION).doc(docId).get()
  if (doc.exists) {
    const data = doc.data() as ExternalAuth
    if (data.userId !== userId) {
      throw new Error('Unauthorized: Cannot delete external auth for another user')
    }
  }

  await db.collection(EXTERNAL_AUTH_COLLECTION).doc(docId).delete()
}

/**
 * Lists configured external tools for a user (without decrypting).
 *
 * @param userId - Internal user UUID
 * @returns List of configured tools with metadata
 */
export async function listExternalAuths(userId: string): Promise<ExternalAuthInfo[]> {
  const db = getFirestore()
  const snapshot = await db
    .collection(EXTERNAL_AUTH_COLLECTION)
    .where('userId', '==', userId)
    .get()

  return snapshot.docs.map((doc) => {
    const data = doc.data() as ExternalAuth
    return {
      toolName: data.toolName,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    }
  })
}

/**
 * Checks if an external auth record exists.
 *
 * @param userId - Internal user UUID
 * @param toolName - Tool identifier
 * @returns True if the record exists
 */
export async function hasExternalAuth(
  userId: string,
  toolName: ToolName,
): Promise<boolean> {
  const db = getFirestore()
  const docId = getDocumentId(userId, toolName)
  const doc = await db.collection(EXTERNAL_AUTH_COLLECTION).doc(docId).get()

  if (!doc.exists) {
    return false
  }

  // Verify userId matches
  const data = doc.data() as ExternalAuth
  return data.userId === userId
}

/**
 * Gets the last 4 characters of an API key (for display purposes).
 * Returns null if the tool is not configured.
 *
 * @param userId - Internal user UUID
 * @param toolName - Tool identifier
 * @returns Last 4 characters of the API key or null
 */
export async function getExternalAuthSuffix(
  userId: string,
  toolName: ToolName,
): Promise<string | null> {
  const apiKey = await getExternalAuth(userId, toolName)
  if (!apiKey) {
    return null
  }

  // Return last 4 characters
  return apiKey.slice(-4)
}
