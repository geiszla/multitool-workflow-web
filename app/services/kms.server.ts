/**
 * Google Cloud KMS Envelope Encryption Service.
 *
 * This module implements envelope encryption using Google Cloud KMS:
 * - DEK (Data Encryption Key): Random 32-byte AES-256 key, unique per secret
 * - KEK (Key Encryption Key): KMS key that wraps the DEK
 *
 * Security properties:
 * - Each secret has its own DEK (limits blast radius)
 * - AAD binding prevents secret swapping between users/tools
 * - AES-256-GCM provides authenticated encryption
 * - KMS handles key rotation (decrypt with stored version, encrypt with latest)
 */

import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { KeyManagementServiceClient } from '@google-cloud/kms'
import { GCP_PROJECT_ID } from './env.server'

// KMS configuration
const KMS_LOCATION = 'europe-west3'
const KMS_KEYRING = 'multitool-workflow-web'
const KMS_KEY = 'api-keys'

// Full KMS key resource name
const KMS_KEY_NAME = `projects/${GCP_PROJECT_ID}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}`

// Lazy-initialized KMS client
let kmsClient: KeyManagementServiceClient | null = null

function getKmsClient(): KeyManagementServiceClient {
  if (!kmsClient) {
    kmsClient = new KeyManagementServiceClient()
  }
  return kmsClient
}

/**
 * Encrypted envelope containing all data needed for decryption.
 */
export interface EncryptedEnvelope {
  wrappedDek: string // Base64-encoded KMS-wrapped DEK
  iv: string // Base64-encoded AES-GCM IV (12 bytes)
  tag: string // Base64-encoded AES-GCM auth tag (16 bytes)
  ciphertext: string // Base64-encoded encrypted plaintext
  kmsKeyVersion: string // KMS key version used for wrapping
}

/**
 * AAD context for binding encryption to a specific user and tool.
 */
export interface AadContext {
  userId: string
  toolName: string
}

/**
 * Creates the AAD buffer from the context.
 * AAD binds the ciphertext to the user and tool, preventing secret swapping.
 */
function createAad(context: AadContext): Buffer {
  return Buffer.from(JSON.stringify({ userId: context.userId, toolName: context.toolName }))
}

/**
 * Encrypts a secret using envelope encryption.
 *
 * Flow:
 * 1. Generate random 32-byte DEK and 12-byte IV
 * 2. Encrypt plaintext with AES-256-GCM using DEK, IV, and AAD
 * 3. Wrap DEK with KMS key
 * 4. Return envelope with all components
 *
 * @param plaintext - The secret to encrypt
 * @param context - AAD context (userId, toolName) for binding
 * @returns Encrypted envelope with all data needed for decryption
 */
export async function encryptSecret(
  plaintext: Buffer,
  context: AadContext,
): Promise<EncryptedEnvelope> {
  const kms = getKmsClient()
  const aad = createAad(context)

  // Generate random DEK (32 bytes for AES-256) and IV (12 bytes for GCM)
  const dek = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)

  // Encrypt plaintext with AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  // Wrap DEK with KMS
  const [wrapResponse] = await kms.encrypt({
    name: KMS_KEY_NAME,
    plaintext: dek,
  })

  if (!wrapResponse.ciphertext) {
    throw new Error('KMS encrypt failed: no ciphertext returned')
  }

  // Securely zero the DEK from memory
  dek.fill(0)

  return {
    wrappedDek: Buffer.from(wrapResponse.ciphertext as Uint8Array).toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    kmsKeyVersion: wrapResponse.name || KMS_KEY_NAME,
  }
}

/**
 * Decrypts a secret from an encrypted envelope.
 *
 * Flow:
 * 1. Unwrap DEK using KMS (uses stored key version)
 * 2. Decrypt ciphertext with AES-256-GCM using DEK, IV, tag, and AAD
 * 3. Return plaintext
 *
 * @param envelope - The encrypted envelope
 * @param context - AAD context (must match encryption context)
 * @returns Decrypted plaintext
 */
export async function decryptSecret(
  envelope: EncryptedEnvelope,
  context: AadContext,
): Promise<Buffer> {
  const kms = getKmsClient()
  const aad = createAad(context)

  // Unwrap DEK using KMS
  // Note: Use the CryptoKey name (not CryptoKeyVersion) for decryption.
  // KMS will automatically determine the correct version from the ciphertext.
  // We store kmsKeyVersion for auditing purposes only.
  const [unwrapResponse] = await kms.decrypt({
    name: KMS_KEY_NAME,
    ciphertext: Buffer.from(envelope.wrappedDek, 'base64'),
  })

  if (!unwrapResponse.plaintext) {
    throw new Error('KMS decrypt failed: no plaintext returned')
  }

  const dek = Buffer.from(unwrapResponse.plaintext as Uint8Array)

  try {
    // Decrypt ciphertext with AES-256-GCM
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(envelope.iv, 'base64'),
    )
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))

    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ])
  }
  finally {
    // Securely zero the DEK from memory
    dek.fill(0)
  }
}

/**
 * Re-encrypts a secret with the latest KMS key version.
 * Useful for key rotation scenarios.
 *
 * @param envelope - The existing encrypted envelope
 * @param context - AAD context (must match original encryption)
 * @returns New envelope encrypted with latest KMS key version
 */
export async function rotateSecret(
  envelope: EncryptedEnvelope,
  context: AadContext,
): Promise<EncryptedEnvelope> {
  // Decrypt with stored key version
  const plaintext = await decryptSecret(envelope, context)

  try {
    // Re-encrypt with latest key version
    return await encryptSecret(plaintext, context)
  }
  finally {
    // Securely zero the plaintext from memory
    plaintext.fill(0)
  }
}
