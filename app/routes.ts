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

  // Authenticated app routes
  layout('routes/_app.tsx', [
    route('agents', 'routes/_app.agents.tsx'),
    route('agents/:id', 'routes/_app.agents.$id.tsx'),
    route('settings', 'routes/_app.settings.tsx'),
  ]),
] satisfies RouteConfig
