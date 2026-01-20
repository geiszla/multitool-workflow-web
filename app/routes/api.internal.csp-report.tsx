/**
 * CSP Violation Report Endpoint.
 *
 * Receives Content-Security-Policy violation reports from browsers.
 * Reports are logged for monitoring CSP violations during Report-Only testing.
 */

import type { Route } from './+types/api.internal.csp-report'

/**
 * CSP report structure from browser.
 */
interface CspReport {
  'csp-report'?: {
    'document-uri'?: string
    'blocked-uri'?: string
    'violated-directive'?: string
    'effective-directive'?: string
    'original-policy'?: string
    'disposition'?: string
    'status-code'?: number
    'script-sample'?: string
    'source-file'?: string
    'line-number'?: number
    'column-number'?: number
  }
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const report = await request.json() as CspReport
    const cspReport = report['csp-report']

    if (cspReport) {
      // Log only structured, safe fields - avoid logging full URLs that could contain sensitive data

      console.warn('CSP Violation:', {
        violatedDirective: cspReport['violated-directive'],
        effectiveDirective: cspReport['effective-directive'],
        blockedUri: cspReport['blocked-uri'],
        disposition: cspReport.disposition,
        // Redact full document-uri to avoid logging sensitive path params
        documentUri: cspReport['document-uri']?.split('?')[0] ?? 'unknown',
      })
    }
  }
  catch (error) {
    // Malformed reports are ignored
    console.error('Failed to parse CSP report:', error instanceof Error ? error.message : 'Unknown error')
  }

  // Always return 204 No Content
  return new Response(null, { status: 204 })
}

// Only POST is allowed
export function loader() {
  return new Response(null, { status: 405 })
}

// No UI for API routes
export default function CspReportApi() {
  return null
}
