/**
 * Health check endpoint for Cloud Run and load balancers.
 *
 * This endpoint is designed to be fast and have no external dependencies.
 * It's used by:
 * - Cloud Run for startup and liveness probes
 * - Load balancers for health checks
 * - Docker HEALTHCHECK command
 *
 * Returns:
 * - 200 OK if the application is healthy
 * - Response time should be < 100ms
 */
export async function loader() {
  return new Response('OK', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      // Prevent caching of health check responses
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  })
}

// No UI needed for health check
export default function Healthz() {
  return null
}
