/**
 * VM Reaper API Endpoint.
 *
 * Called by Cloud Scheduler to automatically suspend/stop inactive VMs.
 * Authenticated via OIDC token from the scheduler service account.
 */

import type { Route } from './+types/api.internal.reaper'
import { runReaper, verifySchedulerToken } from '~/services/reaper.server'

/**
 * Helper to create JSON responses.
 */
function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init)
}

export async function action({ request }: Route.ActionArgs) {
  // Verify Cloud Scheduler OIDC token
  const authHeader = request.headers.get('Authorization')
  const isValid = await verifySchedulerToken(authHeader)

  if (!isValid) {
    console.warn('Reaper API: Unauthorized request')
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Run the reaper
  const result = await runReaper()

  // eslint-disable-next-line no-console
  console.log('Reaper completed:', JSON.stringify(result))

  return json(result)
}

// Only POST is allowed
export function loader() {
  return json({ error: 'Method not allowed' }, { status: 405 })
}

// No UI for API routes
export default function ReaperApi() {
  return null
}
