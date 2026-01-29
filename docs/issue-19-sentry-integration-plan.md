# Issue #19: Add Sentry to the Project - Implementation Plan

**GitHub Issue:** https://github.com/geiszla/multitool-workflow-web/issues/19

**Status:** Draft Plan v2 (Codex-refined)

---

## Scope & Goals

Integrate Sentry **error monitoring** into the application to:
- Capture and report unhandled errors on both client and server
- Provide stack traces with source map support for debugging
- Set up foundation for future error capture enhancements

**Explicitly Out of Scope (v1):**
- Performance tracing / APM
- Profiling
- Session Replay (privacy concerns with terminal UI)
- User Feedback widget
- Additional manual `Sentry.captureException` calls beyond basic setup (e.g., in server.ts catch blocks, WebSocket handlers) - deferred to future issue

**Deliverables:**
1. Server-side Sentry initialization compatible with custom `server.ts`
2. Client-side Sentry initialization
3. Entry point configuration with `handleRequest` and `handleError` wrappers
4. ErrorBoundary integration for client-side error capture
5. Source map upload configuration (using Docker BuildKit secrets)
6. URL/secret scrubbing to prevent sensitive data leakage

---

## Technical Decisions (from Codex Review)

### Package Selection
- Use `@sentry/react-router` - Official unified SDK for React Router (v10.37.0)
- Includes client, server, and Vite plugin integrations

### Initialization Order
- Use Node's ESM preloading (`--import`) for `instrument.server.mjs`
- Sentry must initialize BEFORE `build/server.js` loads any dependencies
- Docker CMD: `["node", "--import", "./instrument.server.mjs", "build/server.js"]`

### Environment Strategy
- Single Sentry project with `environment` tag set from `NODE_ENV`
- Values: `development`, `production`

### URL/Secret Scrubbing
- Implement `beforeSend` hook to sanitize URLs
- Strip sensitive query params: `code`, `state`, `token`, `access_token`, `refresh_token`
- Apply to `event.request.url` and breadcrumb URLs

### Source Map Security
- Use Docker BuildKit secret mounts (not persisted in image layers)
- `SENTRY_AUTH_TOKEN` fetched from Secret Manager during Cloud Build
- Delete `.map` files from served artifacts after upload

---

## Architecture Impact

### Modules/Services Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `package.json` | Modified | Add `@sentry/react-router` |
| `app/entry.client.tsx` | New | Client-side Sentry initialization |
| `app/entry.server.tsx` | New | Server-side handleRequest/handleError exports |
| `instrument.server.mjs` | New | Server-side Sentry initialization (ESM preload) |
| `app/root.tsx` | Modified | Add Sentry.captureException to ErrorBoundary |
| `app/utils/sentry.ts` | New | Shared Sentry config and sanitizeUrl utility |
| `vite.config.ts` | Modified | Add sentryReactRouter plugin for source maps |
| `react-router.config.ts` | Modified | Add buildEnd hook for Sentry |
| `Dockerfile` | Modified | Use BuildKit secrets, update CMD for --import |
| `cloudbuild.yaml` | Modified | Pass SENTRY_AUTH_TOKEN as BuildKit secret |

### External System Integration
- **Sentry SaaS** (sentry.io) - Error tracking service
- **Google Secret Manager** - For `SENTRY_AUTH_TOKEN` (build-time only, via BuildKit)

---

## Task Breakdown

### Task 1: Install Sentry Package
**Purpose:** Add the required Sentry SDK for React Router

**Target Files:** `package.json`

**Steps:**
```bash
pnpm add @sentry/react-router
```

**Package includes:**
- Client-side error capture and React integration
- Server-side error capture for Node.js
- Vite plugin for source map uploads
- React Router-specific helpers

---

### Task 2: Create Shared Sentry Configuration
**Purpose:** Centralize Sentry config and URL sanitization utility

**Target Files:** `app/utils/sentry.ts` (new)

**Implementation:**
```typescript
// Sentry configuration constants (safe to commit)
export const SENTRY_DSN = 'https://<key>@<org>.ingest.sentry.io/<project>';
export const SENTRY_ORG = '<org-slug>';
export const SENTRY_PROJECT = '<project-slug>';

// Sanitize URLs to remove sensitive query parameters
const SENSITIVE_PARAMS = ['code', 'state', 'token', 'access_token', 'refresh_token'];

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const param of SENSITIVE_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// Common beforeSend hook for URL sanitization
export function createBeforeSend() {
  return (event: any) => {
    if (event.request?.url) {
      event.request.url = sanitizeUrl(event.request.url);
    }
    // Sanitize breadcrumb URLs
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.data?.url) {
          breadcrumb.data.url = sanitizeUrl(breadcrumb.data.url);
        }
      }
    }
    return event;
  };
}
```

---

### Task 3: Create Server Instrumentation File
**Purpose:** Initialize Sentry early in Node.js process via ESM preload

**Target Files:** `instrument.server.mjs` (new, in repo root)

**Implementation:**
```javascript
import * as Sentry from '@sentry/react-router';

const SENTRY_DSN = 'https://<key>@<org>.ingest.sentry.io/<project>';

Sentry.init({
  dsn: SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  sendDefaultPii: false,
  beforeSend(event) {
    // URL sanitization (inline since this is ESM preload, can't import from app/)
    if (event.request?.url) {
      try {
        const url = new URL(event.request.url);
        for (const param of ['code', 'state', 'token', 'access_token', 'refresh_token']) {
          if (url.searchParams.has(param)) {
            url.searchParams.set(param, '[REDACTED]');
          }
        }
        event.request.url = url.toString();
      } catch { /* ignore parse errors */ }
    }
    return event;
  },
});

console.log('Sentry initialized for server');
```

**Notes:**
- Must be `.mjs` for Node.js `--import` flag
- Loaded before any application code via `node --import ./instrument.server.mjs`
- No tracing enabled (error monitoring only)

---

### Task 4: Expose and Configure Entry Points
**Purpose:** Reveal React Router entry points for Sentry integration

**Target Files:**
- `app/entry.client.tsx` (new)
- `app/entry.server.tsx` (new)

**Steps:**
1. Run `npx react-router reveal` to expose default entry files
2. Modify for Sentry integration

**entry.client.tsx additions:**
```typescript
import * as Sentry from '@sentry/react-router';
import { SENTRY_DSN, createBeforeSend } from '~/utils/sentry';

Sentry.init({
  dsn: SENTRY_DSN,
  environment: import.meta.env.MODE,
  sendDefaultPii: false,
  beforeSend: createBeforeSend(),
});
```

**entry.server.tsx additions:**
```typescript
import * as Sentry from '@sentry/react-router';

// Wrap request handler for error capture
export const handleRequest = Sentry.createSentryHandleRequest();

// Capture server-side rendering errors
export const handleError = Sentry.createSentryHandleError();
```

---

### Task 5: Integrate with ErrorBoundary
**Purpose:** Capture client-side React errors in Sentry

**Target Files:** `app/root.tsx`

**Changes:**
```typescript
import * as Sentry from '@sentry/react-router';

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // Capture server errors (5xx) to Sentry, skip client errors (4xx)
  if (!isRouteErrorResponse(error) || error.status >= 500) {
    Sentry.captureException(error);
  }

  // ... existing error display logic (unchanged)
}
```

---

### Task 6: Configure Source Map Upload
**Purpose:** Enable readable stack traces in Sentry

**Target Files:** `vite.config.ts`, `react-router.config.ts`

**vite.config.ts changes:**
```typescript
import { sentryReactRouter } from '@sentry/react-router';

const SENTRY_ORG = '<org-slug>';
const SENTRY_PROJECT = '<project-slug>';

export default defineConfig({
  build: {
    sourcemap: true, // Required for Sentry
  },
  plugins: [
    sentryReactRouter({
      org: SENTRY_ORG,
      project: SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: {
        filesToDeleteAfterUpload: ['./build/**/*.map'], // Don't ship .map files
      },
      // Gracefully skip if no auth token (local dev)
      silent: !process.env.SENTRY_AUTH_TOKEN,
    }),
    reactRouter(),
    tsconfigPaths(),
  ],
});
```

**react-router.config.ts changes:**
```typescript
import { sentryOnBuildEnd } from '@sentry/react-router';

export default {
  async buildEnd() {
    await sentryOnBuildEnd();
  },
  async prerender() {
    return ['/', '/design-system'];
  },
} satisfies Config;
```

**Notes:**
- Source maps generated during build, uploaded to Sentry, then deleted
- Local builds without `SENTRY_AUTH_TOKEN` skip upload silently

---

### Task 7: Update Dockerfile with BuildKit Secrets
**Purpose:** Securely pass SENTRY_AUTH_TOKEN during build without persisting

**Target Files:** `Dockerfile`

**Changes:**

```dockerfile
# syntax=docker/dockerfile:1.4
# ^^^ Required for BuildKit secret mounts

# ... (stages 1-2 unchanged) ...

# ==============================================================================
# Stage 3: Build the application (with Sentry source map upload)
# ==============================================================================
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

# Build with Sentry auth token (secret not persisted in layer)
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN=$(cat /run/secrets/sentry_auth_token 2>/dev/null || echo "") \
    pnpm build

# ... (stage 4 unchanged) ...

# ==============================================================================
# Stage 5: Final production image
# ==============================================================================
FROM node:24-alpine AS runner

# ... (user setup unchanged) ...

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json

# Copy Sentry instrumentation file
COPY --from=build /app/instrument.server.mjs ./instrument.server.mjs

# ... (ownership, user switch unchanged) ...

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

# Start with Sentry instrumentation preloaded
CMD ["node", "--import", "./instrument.server.mjs", "build/server.js"]
```

---

### Task 8: Update Cloud Build Configuration
**Purpose:** Pass SENTRY_AUTH_TOKEN from Secret Manager to Docker build

**Target Files:** `cloudbuild.yaml`

**Changes:**
```yaml
steps:
  # Write secret to file for BuildKit
  - name: 'gcr.io/cloud-builders/gcloud'
    entrypoint: 'bash'
    args:
      - '-c'
      - |
        gcloud secrets versions access latest \
          --secret=sentry-auth-token \
          --project=$PROJECT_ID > /workspace/.sentry-token

  # Build with BuildKit secret mount
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - 'build'
      - '--secret=id=sentry_auth_token,src=/workspace/.sentry-token'
      - '-t'
      - 'gcr.io/$PROJECT_ID/multitool-workflow-web:$COMMIT_SHA'
      - '-t'
      - 'gcr.io/$PROJECT_ID/multitool-workflow-web:latest'
      - '.'
    env:
      - 'DOCKER_BUILDKIT=1'

  # ... (push, deploy steps) ...
```

**Prerequisites:**
- Create secret in Secret Manager: `sentry-auth-token`
- Grant Cloud Build service account access to the secret

---

## Risk Areas & Watch-Outs

### Security
- [x] `SENTRY_AUTH_TOKEN` via BuildKit secrets (never persisted in image)
- [x] `sendDefaultPii: false` enforced (no IP addresses, headers)
- [x] URL sanitization removes OAuth tokens from error reports
- [ ] Verify Sentry data retention settings match compliance requirements

### Performance
- [x] No tracing/profiling (error monitoring only) - minimal overhead
- [x] Source maps deleted after upload (not shipped to clients)
- [ ] Monitor Sentry quota usage after deployment

### Backwards Compatibility
- [x] Application works if Sentry fails to initialize (graceful degradation)
- [x] Build succeeds without `SENTRY_AUTH_TOKEN` (skips upload)

### Custom Server Considerations
- [x] ESM preload ensures Sentry initializes before app code
- [x] handleRequest/handleError wrappers capture SSR errors
- [x] ErrorBoundary captures client-side React errors

---

## Checklist Summary

1. [ ] Install package: `@sentry/react-router`
2. [ ] Create `app/utils/sentry.ts` with config and sanitization
3. [ ] Create `instrument.server.mjs` for server-side initialization
4. [ ] Run `npx react-router reveal` and modify entry files with handleRequest/handleError
5. [ ] Update `app/root.tsx` ErrorBoundary with Sentry.captureException
6. [ ] Update `vite.config.ts` with Sentry plugin
7. [ ] Update `react-router.config.ts` with buildEnd hook
8. [ ] Update `Dockerfile` with BuildKit syntax and instrumentation
9. [ ] Update `cloudbuild.yaml` to pass secret
10. [ ] Create `sentry-auth-token` secret in Secret Manager
11. [ ] Test error capture in development
12. [ ] Deploy and verify errors appear in Sentry dashboard

---

## Future Work (Separate Issues)

- Add manual `Sentry.captureException` calls in strategic locations (server.ts catch blocks, WebSocket handlers)
- Add graceful shutdown with `Sentry.close()` flush
- Enable performance tracing if needed
- Add custom tags and context to errors
