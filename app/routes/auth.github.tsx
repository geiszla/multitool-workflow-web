import type { Route } from './+types/auth.github'
import { getAuthenticator, sanitizeReturnTo, storeReturnTo } from '~/services/auth.server'

/**
 * GitHub OAuth initiation route.
 *
 * This route starts the OAuth flow by:
 * 1. Storing the returnTo URL in a signed cookie
 * 2. Redirecting to GitHub's authorization page via remix-auth
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'))

  // Store returnTo in a signed cookie for the callback
  const returnToCookie = await storeReturnTo(returnTo)

  // Get the authenticator and start the OAuth flow
  const authenticator = await getAuthenticator()

  // The authenticate method will throw a redirect to GitHub
  // We need to add our returnTo cookie to the response
  try {
    await authenticator.authenticate('github', request)
  }
  catch (response) {
    // remix-auth throws a Response for redirects
    if (response instanceof Response) {
      // Add our returnTo cookie to the redirect response
      const headers = new Headers(response.headers)
      headers.append('Set-Cookie', returnToCookie)
      return new Response(null, {
        status: response.status,
        headers,
      })
    }
    throw response
  }

  // This should never be reached as authenticate() always throws
  return null
}

// This route only has a loader (redirect), no UI component needed
export default function AuthGitHub() {
  return null
}
