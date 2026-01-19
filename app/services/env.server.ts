/**
 * Environment validation module.
 *
 * This module validates all required environment variables at application startup.
 * If any required variables are missing, the application will fail fast with a clear error message.
 *
 * IMPORTANT: This module should be imported early in the application lifecycle.
 *
 * Note: Validation is deferred during build time. The build process doesn't need
 * runtime environment variables - they're only required when the server starts.
 */

// GCP Project ID - hardcoded for this project
export const GCP_PROJECT_ID = 'multitool-workflow-web'

/**
 * Environment configuration with validation.
 */
interface EnvConfig {
  NODE_ENV: 'development' | 'production' | 'test'
  APP_URL: string
  FIRESTORE_EMULATOR_HOST: string | undefined
}

// Cached environment config
let cachedEnv: EnvConfig | null = null

/**
 * Validates and returns environment configuration.
 * Throws an error if required variables are missing.
 * Uses lazy initialization to avoid validation during build time.
 */
function validateEnv(): EnvConfig {
  // Return cached config if already validated
  if (cachedEnv) {
    return cachedEnv
  }

  const errors: string[] = []

  // Required variables
  const appUrl = process.env.APP_URL
  if (!appUrl) {
    errors.push('APP_URL is required (e.g., http://localhost:3000)')
  }

  // Validate NODE_ENV
  const nodeEnv = process.env.NODE_ENV || 'development'
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    errors.push(
      `NODE_ENV must be one of: development, production, test (got: ${nodeEnv})`,
    )
  }

  // If there are validation errors, fail fast
  if (errors.length > 0) {
    const errorMessage = [
      '',
      '='.repeat(60),
      'ENVIRONMENT VALIDATION FAILED',
      '='.repeat(60),
      '',
      'The following environment variables are missing or invalid:',
      '',
      ...errors.map(e => `  - ${e}`),
      '',
      'Please check your .env file or environment configuration.',
      '='.repeat(60),
      '',
    ].join('\n')

    console.error(errorMessage)
    throw new Error('Environment validation failed. See above for details.')
  }

  cachedEnv = {
    NODE_ENV: nodeEnv as EnvConfig['NODE_ENV'],
    APP_URL: appUrl!,
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  }

  return cachedEnv
}

/**
 * Environment configuration object.
 * Uses a getter to enable lazy validation - env vars are only checked when accessed.
 * This allows the module to be imported during build without requiring runtime env vars.
 */
export const env = {
  get NODE_ENV() {
    return validateEnv().NODE_ENV
  },
  get APP_URL() {
    return validateEnv().APP_URL
  },
  get FIRESTORE_EMULATOR_HOST() {
    return validateEnv().FIRESTORE_EMULATOR_HOST
  },
}

/**
 * Helper to check if we're in development mode.
 */
export function isDevelopment(): boolean {
  return env.NODE_ENV === 'development'
}

/**
 * Helper to check if we're in production mode.
 */
export function isProduction(): boolean {
  return env.NODE_ENV === 'production'
}

/**
 * Helper to check if Firestore emulator is configured.
 */
export function isFirestoreEmulatorEnabled(): boolean {
  return !!env.FIRESTORE_EMULATOR_HOST
}
