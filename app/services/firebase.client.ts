/**
 * Firebase Client Service.
 *
 * Initializes and configures the Firebase client SDK for browser use.
 * Provides Firestore instance for realtime subscriptions.
 *
 * Note: This is a client-only module. Import only in client components.
 */

import type { FirebaseApp } from 'firebase/app'
import type { Auth, User } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'
import { getApps, initializeApp } from 'firebase/app'
import { getAuth, signInWithCustomToken } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

// Firebase client configuration
// These are public configuration values, not secrets
// Uses Vite environment variables for staging/prod flexibility
const firebaseConfig = {
  apiKey: 'AIzaSyAEVk_7ka5fpZ6LMKsUP6PJ1_9hoZOqkj8',
  authDomain: 'multitool-workflow-web.firebaseapp.com',
  projectId: 'multitool-workflow-web',
  storageBucket: 'multitool-workflow-web.firebasestorage.app',
  messagingSenderId: '629475955836',
  appId: '1:629475955836:web:c017cfd662dc3774f6a5f9',
}

// Singleton instances
let app: FirebaseApp | null = null
let auth: Auth | null = null
let firestore: Firestore | null = null

/**
 * Initializes the Firebase app.
 * Safe to call multiple times - will reuse existing instance.
 */
export function initFirebase(): FirebaseApp {
  if (app) {
    return app
  }

  const existingApps = getApps()
  if (existingApps.length > 0) {
    app = existingApps[0]
    return app
  }

  app = initializeApp(firebaseConfig)
  return app
}

/**
 * Gets the Firebase Auth instance.
 */
export function getFirebaseAuth(): Auth {
  if (auth) {
    return auth
  }

  const firebaseApp = initFirebase()
  auth = getAuth(firebaseApp)
  return auth
}

/**
 * Gets the Firestore instance.
 */
export function getClientFirestore(): Firestore {
  if (firestore) {
    return firestore
  }

  const firebaseApp = initFirebase()
  firestore = getFirestore(firebaseApp)
  return firestore
}

/**
 * Signs in to Firebase with a custom token.
 *
 * @param token - Custom token from server
 * @returns Firebase user
 */
export async function signInWithToken(token: string): Promise<User> {
  const firebaseAuth = getFirebaseAuth()
  const credential = await signInWithCustomToken(firebaseAuth, token)
  return credential.user
}

/**
 * Gets the current Firebase user.
 */
export function getCurrentUser(): User | null {
  const firebaseAuth = getFirebaseAuth()
  return firebaseAuth.currentUser
}

/**
 * Signs out of Firebase.
 */
export async function signOut(): Promise<void> {
  const firebaseAuth = getFirebaseAuth()
  await firebaseAuth.signOut()
}

/**
 * Waits for Firebase auth to be ready.
 */
export function onAuthReady(): Promise<User | null> {
  return new Promise((resolve) => {
    const firebaseAuth = getFirebaseAuth()
    const unsubscribe = firebaseAuth.onAuthStateChanged((user) => {
      unsubscribe()
      resolve(user)
    })
  })
}
