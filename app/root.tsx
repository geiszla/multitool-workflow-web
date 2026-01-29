import type { Route } from './+types/root'

import { ColorSchemeScript, MantineProvider } from '@mantine/core'
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router'
import '@mantine/core/styles.css'
import './app.css'

export const links: Route.LinksFunction = () => [
  { rel: 'icon', href: '/favicon.ico' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap',
  },
]

export function meta(): Route.MetaDescriptors {
  return [
    { title: 'Multitool Workflow' },
    {
      name: 'description',
      content: 'Run AI-assisted workflows on GitHub repositories',
    },
  ]
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider defaultColorScheme="auto">
          {children}
        </MantineProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let status = 500
  let message = 'Oops!'
  let details = 'An unexpected error occurred. Please try again later.'

  if (isRouteErrorResponse(error)) {
    status = error.status
    switch (error.status) {
      case 404:
        message = 'Page Not Found'
        details = 'The page you\'re looking for doesn\'t exist.'
        break
      case 401:
        message = 'Unauthorized'
        details = 'You need to sign in to access this page.'
        break
      case 403:
        message = 'Forbidden'
        details = 'You don\'t have permission to access this page.'
        break
      default:
        message = 'Error'
        details = error.statusText || details
    }
  }

  // In development, show more error details (but never in production)
  const showStack
    = import.meta.env.DEV && error instanceof Error && error.stack

  return (
    <MantineProvider defaultColorScheme="auto">
      <div
        style={{
          display: 'flex',
          minHeight: '100vh',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '28rem' }}>
          <p style={{ fontSize: '3.75rem', fontWeight: 'bold', color: 'var(--mantine-color-dimmed)' }}>
            {status}
          </p>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginTop: '1rem' }}>
            {message}
          </h1>
          <p style={{ color: 'var(--mantine-color-dimmed)', marginTop: '0.5rem' }}>
            {details}
          </p>
          <div style={{ marginTop: '1.5rem' }}>
            <a
              href="/"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--mantine-radius-md)',
                backgroundColor: 'var(--mantine-primary-color-filled)',
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: 'white',
                textDecoration: 'none',
              }}
            >
              Go back home
            </a>
          </div>
          {showStack && (
            <pre
              style={{
                marginTop: '2rem',
                width: '100%',
                overflowX: 'auto',
                borderRadius: 'var(--mantine-radius-md)',
                backgroundColor: 'var(--mantine-color-dark-6)',
                padding: '1rem',
                textAlign: 'left',
                fontSize: '0.75rem',
              }}
            >
              <code>{error.stack}</code>
            </pre>
          )}
        </div>
      </div>
    </MantineProvider>
  )
}
