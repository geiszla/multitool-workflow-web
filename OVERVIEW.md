# Multitool Workflow Web - Architecture Overview

Cloud-based web interface for running AI-assisted workflows on GitHub repositories.

## Technology Stack

- **Framework**: React Router v7 (formerly Remix) + Vite - SSR, file-based routing, excellent DX
- **Package Manager**: pnpm - fast, disk-efficient, strict dependencies
- **Runtime**: Node.js 24 LTS
- **UI**: Mantine v8 - React component library with built-in theming
- **Icons**: @tabler/icons-react - Mantine's recommended icon set
- **Database**: Google Cloud Firestore Native - serverless, real-time capable
- **Deployment**: Google Cloud Run - serverless containers, auto-scaling
- **Secrets**: Google Cloud Secret Manager - IAM-based, audit logging

## Authentication

- **Provider**: GitHub OAuth via `remix-auth` + `remix-auth-github`
- **Scopes**: `read:user user:email repo`
- **Flow**: OAuth2 with state validation (CSRF protection via arctic library)
- **Session**: Server-side (Firestore) with signed cookie containing session ID
- **TTL**: 30 days
- **Fail-closed**: If Firestore is unavailable, redirect to login

### Session Semantics

The cookie contains `{ sessionId: string }`. On every protected request, the session is validated against Firestore (checking expiry and revocation status) and the user profile is fetched from Firestore. If Firestore validation fails or is unavailable, the session is treated as invalid and the user is redirected to login (fail-closed security model).

## Data Model

- **Users** (`users/{githubId}`): Profile info, timestamps
- **Sessions** (`sessions/{sessionId}`): userId, expiry, revocation status, lastSeenAt

## Security Invariants

1. **Fail closed**: Protected pages MUST redirect to login if Firestore is unavailable
2. **No token storage**: Access tokens are NOT stored (deferred to Parts 2-3)
3. **returnTo sanitization**: Only relative paths starting with "/" are allowed (prevents open redirect)
4. **Session validation**: Every protected request validates session against Firestore
5. **lastSeenAt throttling**: Updates only if older than 5 minutes (reduces Firestore writes)
6. **Logout correctness**: Revokes Firestore session FIRST, then destroys cookie

### Cookie Security

- httpOnly: true (prevents XSS access)
- secure: true in production (HTTPS only)
- sameSite: lax (CSRF protection)
- Signed with session-secret (integrity protection)

## UI Architecture

- **Component Library**: Mantine v8 with CSS-in-JS
- **Layout**: Mantine AppShell with Header and Navbar
- **Dark Mode**: System-following only (via `prefers-color-scheme`)
- **Icons**: @tabler/icons-react

## Required Secrets

- `github-client-id` - GitHub OAuth App client ID
- `github-client-secret` - GitHub OAuth App client secret
- `session-secret` - Session cookie signing secret (min 32 chars)

## Deployment

- Multi-stage Dockerfile with pnpm
- Cloud Build CI/CD on push to main
- Health check at `/healthz`

## Non-Goals (Part 1)

- Access token storage with KMS encryption (Part 2-3)
- Workflow functionality (Part 2-3)
- Additional authentication providers
- User-controlled dark mode toggle
