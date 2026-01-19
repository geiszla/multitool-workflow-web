import type { Route } from './+types/auth.github.callback'
import { Center, Loader, Stack, Text, Title } from '@mantine/core'
import { redirect } from 'react-router'
import { saveExternalAuth } from '~/models/external-auth.server'
import { upsertUser } from '~/models/user.server'
import { getAndClearReturnTo, getAuthenticator } from '~/services/auth.server'
import { createUserSession } from '~/services/session.server'

/**
 * GitHub OAuth callback route.
 *
 * This route handles the OAuth callback by:
 * 1. Completing the OAuth flow via remix-auth
 * 2. Creating/updating the user in Firestore
 * 3. Storing the GitHub access token (encrypted with KMS)
 * 4. Creating a session and redirecting to the agents page
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const error = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')

  // Handle OAuth errors from GitHub
  if (error) {
    console.error('GitHub OAuth error:', error, errorDescription)

    if (error === 'access_denied') {
      return redirect('/?error=access_denied')
    }

    return redirect('/?error=auth_failed')
  }

  try {
    // Complete the OAuth flow and get the GitHub user + access token
    const authenticator = await getAuthenticator()
    const { user: githubUser, accessToken } = await authenticator.authenticate('github', request)

    // Get the returnTo URL and clear the cookie
    const { returnTo, clearCookie } = await getAndClearReturnTo(request)

    // Create or update the user in Firestore
    // Returns internal UUID (not GitHub ID)
    const userId = await upsertUser({
      githubId: String(githubUser.id),
      githubLogin: githubUser.login,
      name: githubUser.name,
      email: githubUser.email,
      avatarUrl: githubUser.avatarUrl,
    })

    // Store the GitHub access token encrypted with KMS
    // This token is used for GitHub API calls when creating agents
    await saveExternalAuth(userId, 'github', accessToken)

    // Create the user session (this will redirect)
    const sessionResponse = await createUserSession({
      request,
      userId,
      redirectTo: returnTo,
    })

    // Add the clear returnTo cookie header to the response
    const headers = new Headers(sessionResponse.headers)
    headers.append('Set-Cookie', clearCookie)

    return new Response(null, {
      status: sessionResponse.status,
      headers,
    })
  }
  catch (error) {
    // Re-throw Response objects (remix-auth uses them for redirects)
    if (error instanceof Response) {
      throw error
    }
    // Log error without sensitive details (OAuth codes, tokens could be in error)
    console.error('OAuth callback error:', error instanceof Error ? error.message : 'Unknown error')
    return redirect('/?error=auth_failed')
  }
}

// Fallback UI in case the loader doesn't redirect
export default function AuthGitHubCallback() {
  return (
    <Center style={{ minHeight: '100vh' }}>
      <Stack align="center" gap="md">
        <Loader size="lg" />
        <Title order={2}>Authenticating...</Title>
        <Text c="dimmed">
          Please wait while we complete the sign-in process.
        </Text>
      </Stack>
    </Center>
  )
}
