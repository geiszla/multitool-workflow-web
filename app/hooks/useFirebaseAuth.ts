/**
 * Firebase Authentication Hook.
 *
 * Handles Firebase client authentication using custom tokens from the server.
 * Provides authentication state for realtime Firestore subscriptions.
 */

import type { User } from 'firebase/auth'
import { useCallback, useEffect, useState } from 'react'

/**
 * Firebase auth state.
 */
interface FirebaseAuthState {
  user: User | null
  loading: boolean
  error: Error | null
  authenticated: boolean
}

/**
 * Hook to manage Firebase authentication.
 *
 * Fetches a custom token from the server and signs in to Firebase.
 * The Firebase SDK handles token refresh automatically.
 */
export function useFirebaseAuth(): FirebaseAuthState {
  const [state, setState] = useState<FirebaseAuthState>({
    user: null,
    loading: true,
    error: null,
    authenticated: false,
  })

  const initAuth = useCallback(async () => {
    try {
      // Dynamically import Firebase client (client-only)
      const { signInWithToken, onAuthReady, getCurrentUser } = await import('~/services/firebase.client')

      // Check if already authenticated
      await onAuthReady()
      const existingUser = getCurrentUser()

      if (existingUser) {
        setState({
          user: existingUser,
          loading: false,
          error: null,
          authenticated: true,
        })
        return
      }

      // Fetch custom token from server
      const response = await fetch('/api/auth/firebase-token')

      if (!response.ok) {
        throw new Error(`Failed to fetch token: ${response.status}`)
      }

      const data = await response.json() as { token?: string, error?: string }

      if (data.error) {
        throw new Error(data.error)
      }

      if (!data.token) {
        throw new Error('No token received')
      }

      // Sign in with custom token
      const user = await signInWithToken(data.token)

      setState({
        user,
        loading: false,
        error: null,
        authenticated: true,
      })
    }
    catch (error) {
      console.error('Firebase auth error:', error)
      setState({
        user: null,
        loading: false,
        error: error instanceof Error ? error : new Error('Unknown error'),
        authenticated: false,
      })
    }
  }, [])

  useEffect(() => {
    initAuth()
  }, [initAuth])

  return state
}
