/**
 * GitHub OAuth Authentication Service using remix-auth.
 *
 * This module implements GitHub OAuth authentication using remix-auth and remix-auth-github.
 * It handles:
 * - OAuth flow with GitHub
 * - User info fetching from GitHub API
 * - Lazy initialization of authenticator (secrets may be unavailable at build time)
 *
 * Note: PKCE is not used as remix-auth-github uses arctic which handles
 * state validation for CSRF protection.
 */

import { Octokit } from '@octokit/rest'
import { createCookie } from 'react-router'
import { Authenticator } from 'remix-auth'
import { GitHubStrategy } from 'remix-auth-github'
import { env, isDevelopment } from './env.server'
import { getSecret } from './secrets.server'

/**
 * GitHub user data from the API.
 */
export interface GitHubUser {
  id: number
  login: string
  name: string | null
  email: string | null
  avatarUrl: string
}

/**
 * GitHub auth result including user data and access token.
 */
export interface GitHubAuthResult {
  user: GitHubUser
  accessToken: string
}

// OAuth scopes required by the application
const OAUTH_SCOPES = ['read:user', 'user:email', 'repo'] as const

// Temporary state cookie for returnTo URL during OAuth flow
const RETURN_TO_COOKIE_MAX_AGE = 60 * 10 // 10 minutes

// Lazy-initialized authenticator (secrets may be unavailable at build time)
// Note: We cache successful initialization but NOT failures, allowing retry on next request
let authenticatorCache: Authenticator<GitHubAuthResult> | null = null

// Lazy-initialized returnTo cookie
// Note: We cache successful initialization but NOT failures, allowing retry on next request
let returnToCookieCache: Awaited<ReturnType<typeof createSignedReturnToCookie>> | null = null

async function createSignedReturnToCookie() {
  const sessionSecret = await getSecret('session-secret')
  return createCookie('__return_to', {
    httpOnly: true,
    maxAge: RETURN_TO_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    secrets: [sessionSecret],
  })
}

async function getReturnToCookie() {
  // Return cached cookie if already successfully initialized
  if (returnToCookieCache) {
    return returnToCookieCache
  }

  // Create and cache the cookie (failures will throw and not be cached)
  returnToCookieCache = await createSignedReturnToCookie()
  return returnToCookieCache
}

/**
 * Sanitizes the returnTo URL to prevent open redirect vulnerabilities.
 * Only allows relative paths starting with "/" but rejects protocol-relative URLs
 * like "//evil.com" or paths with backslashes that could be exploited.
 */
export function sanitizeReturnTo(input: string | null, fallback = '/agents'): string {
  if (!input)
    return fallback

  const trimmed = input.trim()

  if (!trimmed.startsWith('/'))
    return fallback

  // Avoid oversized cookies and pathological inputs
  if (trimmed.length > 2048)
    return fallback

  try {
    // Resolve against a fixed same-origin base and ensure the result stays on that origin.
    // This blocks absolute URLs, protocol-relative URLs (//evil.com), and parser edge cases
    // where the authority could be smuggled in (e.g. "/\\evil.com", newlines).
    const base = new URL('https://return-to.local')
    const resolved = new URL(trimmed, base)
    if (resolved.origin !== base.origin)
      return fallback

    return `${resolved.pathname}${resolved.search}${resolved.hash}` || fallback
  }
  catch {
    return fallback
  }
}

/**
 * Stores the returnTo URL in a signed cookie for the OAuth flow.
 */
export async function storeReturnTo(returnTo: string): Promise<string> {
  const cookie = await getReturnToCookie()
  return cookie.serialize(returnTo)
}

/**
 * Retrieves and clears the returnTo URL from the cookie.
 */
export async function getAndClearReturnTo(
  request: Request,
): Promise<{ returnTo: string, clearCookie: string }> {
  const cookie = await getReturnToCookie()
  const cookieHeader = request.headers.get('Cookie')
  const returnTo = await cookie.parse(cookieHeader)
  const clearCookie = await cookie.serialize(null, { maxAge: 0 })
  return {
    returnTo: sanitizeReturnTo(returnTo),
    clearCookie,
  }
}

/**
 * Creates the authenticator with the GitHub strategy.
 * Uses lazy initialization because secrets may not be available at build time.
 */
async function createAuthenticator(): Promise<Authenticator<GitHubAuthResult>> {
  const suffix = isDevelopment() ? '-dev' : ''
  const clientId = await getSecret(`github-client-id${suffix}`)
  const clientSecret = await getSecret(`github-client-secret${suffix}`)

  const oauthCookie
    = process.env.NODE_ENV === 'production'
      ? ({
          // "__Host-" requires Secure, path="/", and no Domain attribute.
          name: '__Host-github-oauth',
          secure: true,
          path: '/',
          sameSite: 'Lax',
          httpOnly: true,
        } as const)
      : ({
          name: 'github-oauth',
          path: '/',
          sameSite: 'Lax',
          httpOnly: true,
        } as const)

  const authenticator = new Authenticator<GitHubAuthResult>()

  authenticator.use(
    new GitHubStrategy(
      {
        clientId,
        clientSecret,
        redirectURI: `${env.APP_URL}/auth/github/callback`,
        scopes: [...OAUTH_SCOPES],
        cookie: oauthCookie,
      },
      async ({ tokens }) => {
        const accessToken = tokens.accessToken()
        // Fetch user information from GitHub
        const user = await fetchGitHubUser(accessToken)
        return { user, accessToken }
      },
    ),
    'github',
  )

  return authenticator
}

/**
 * Gets or creates the authenticator instance.
 * Note: We cache successful initialization but NOT failures, allowing retry on next request.
 */
export async function getAuthenticator(): Promise<Authenticator<GitHubAuthResult>> {
  // Return cached authenticator if already successfully initialized
  if (authenticatorCache) {
    return authenticatorCache
  }

  // Create and cache the authenticator (failures will throw and not be cached)
  authenticatorCache = await createAuthenticator()
  return authenticatorCache
}

/**
 * Creates an authenticated Octokit client for the given access token.
 */
function createOctokitClient(accessToken: string): Octokit {
  return new Octokit({
    auth: accessToken,
  })
}

/**
 * Fetches the authenticated user's information from GitHub using Octokit.
 */
async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const octokit = createOctokitClient(accessToken)

  // Fetch the authenticated user's profile
  const { data: user } = await octokit.users.getAuthenticated()

  let email = user.email

  // If the user's email is private, fetch it from the emails endpoint
  if (!email) {
    try {
      const { data: emails } = await octokit.users.listEmailsForAuthenticatedUser({
        per_page: 100, // Fetch up to 100 emails (more than enough for any user)
      })
      const primaryEmail = emails.find(e => e.primary && e.verified)
      if (primaryEmail) {
        email = primaryEmail.email
      }
    }
    catch (error) {
      // Email fetch failed - continue without email
      // This can happen if:
      // - The user doesn't have the user:email scope (403)
      // - Rate limiting (403)
      // - Temporary GitHub API outage
      // Log for debugging but don't fail auth - email is optional
      console.warn('Failed to fetch user emails from GitHub:', error instanceof Error ? error.message : 'Unknown error')
    }
  }

  return {
    id: user.id,
    login: user.login,
    name: user.name,
    email,
    avatarUrl: user.avatar_url,
  }
}
