import type { RouteConfig } from '@react-router/dev/routes'
import { index, layout, route } from '@react-router/dev/routes'

export default [
  // Public routes
  index('routes/home.tsx'),
  route('design-system', 'routes/design-system.tsx'),

  // Health check (for Cloud Run)
  route('healthz', 'routes/healthz.tsx'),

  // Auth routes
  route('auth/github', 'routes/auth.github.tsx'),
  route('auth/github/callback', 'routes/auth.github.callback.tsx'),
  route('auth/logout', 'routes/auth.logout.tsx'),

  // API routes (for VM communication)
  route('api/agents/:id/credentials', 'routes/api.agents.$id.credentials.tsx'),
  route('api/agents/:id/status', 'routes/api.agents.$id.status.tsx'),
  route('api/agents/:id/activity', 'routes/api.agents.$id.activity.tsx'),
  route('api/auth/firebase-token', 'routes/api.auth.firebase-token.tsx'),

  // Authenticated app routes
  layout('routes/_app.tsx', [
    route('agents', 'routes/_app.agents.tsx'),
    route('agents/:id', 'routes/_app.agents.$id.tsx'),
    route('settings', 'routes/_app.settings.tsx'),
  ]),
] satisfies RouteConfig
