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
- **Encryption**: Google Cloud KMS - envelope encryption for API keys
- **Compute**: Google Compute Engine - VMs for running Claude Code agents

## Authentication

- **Provider**: GitHub OAuth via `remix-auth` + `remix-auth-github`
- **Scopes**: `read:user user:email repo`
- **Flow**: OAuth2 with state validation (CSRF protection via arctic library)
- **Session**: Server-side (Firestore) with signed cookie containing session ID
- **TTL**: 30 days
- **Fail-closed**: If Firestore is unavailable, redirect to login

### Session Semantics

The cookie contains `{ sessionId: string }`. On every protected request, the session is validated against Firestore (checking expiry and revocation status) and the user profile is fetched from Firestore. If Firestore validation fails or is unavailable, the session is treated as invalid and the user is redirected to login (fail-closed security model).

## User Identity

- **Internal UUID**: Users are identified by an internal UUID, not their GitHub ID
- **Rationale**: Supports future login methods (Google, email, etc.) without changing identity
- **GitHub ID**: Stored as `githubId` field for OAuth lookup
- **Migration**: Legacy users (GitHub ID as doc ID) are migrated lazily on login

## Data Model

### Users (`users/{userId}`)
- `id`: Internal UUID (same as document ID)
- `githubId`: GitHub user ID (for OAuth reference)
- `githubLogin`: GitHub username
- `name?`: Display name
- `email?`: Email address
- `avatarUrl`: GitHub avatar URL
- `createdAt`, `updatedAt`, `lastLoginAt`: Timestamps

### Sessions (`sessions/{sessionId}`)
- `userId`: Internal user UUID
- `createdAt`, `expiresAt`, `revokedAt?`, `lastSeenAt`: Timestamps

### External Auth (`external_auth/{userId}_{toolName}`)
Stores encrypted API keys for external tools.
- `userId`: Internal user UUID
- `toolName`: Tool identifier (`claude`, `codex`, `github`)
- `wrappedDek`: KMS-wrapped Data Encryption Key (Base64)
- `iv`: AES-GCM initialization vector (Base64)
- `tag`: AES-GCM auth tag (Base64)
- `ciphertext`: Encrypted API key (Base64)
- `kmsKeyVersion`: KMS key version used for wrapping
- `createdAt`, `updatedAt`: Timestamps

### Agents (`agents/{agentId}`)
Stores agent records with status and metadata.
- `id`: UUID
- `userId`: Internal user UUID
- `title`: Display title
- `status`: State machine status
- `statusVersion`: Optimistic locking version
- `repoOwner`, `repoName`, `branch`: Target repository
- `issueNumber?`, `issueTitle?`: Optional GitHub issue
- `instructions?`: User instructions for the agent
- `startedAt?`, `suspendedAt?`, `stoppedAt?`, `completedAt?`: Timestamps
- `errorMessage?`: Error details if failed
- `instanceName?`, `instanceZone?`, `instanceStatus?`: GCE instance info
- `createdAt`, `updatedAt`: Timestamps

## API Key Encryption

Uses **envelope encryption** with AES-256-GCM + Google Cloud KMS:

1. **Data Encryption Key (DEK)**: Random 32-byte key, unique per secret
2. **Key Encryption Key (KEK)**: KMS key that wraps the DEK
3. **AAD Binding**: Ciphertext bound to `{userId, toolName}` to prevent secret swapping
4. **Flow**:
   - Encrypt: Generate DEK -> Encrypt plaintext with AES-GCM -> Wrap DEK with KMS
   - Decrypt: Unwrap DEK with KMS -> Decrypt ciphertext with AES-GCM

**Security Properties**:
- Each secret has its own DEK (limits blast radius)
- AAD prevents secret swapping between users or tools
- KMS handles key rotation (decrypt with stored version, encrypt with latest)
- Plaintext never stored, logged, or sent to client

## Agent State Machine

Valid status transitions (enforced server-side with optimistic locking):

```
pending -> provisioning
provisioning -> running | failed
running -> suspended | stopped | completed | failed | cancelled
suspended -> running (resume) | stopped | cancelled
stopped -> running (start) | cancelled
Terminal: completed, failed, cancelled (no transitions out)
```

**Optimistic Locking**: `statusVersion` is incremented on each transition. Updates fail with 409 if current status doesn't match expected.

## Compute Engine Integration

- **Machine Type**: e2-medium (configurable per user tier in future)
- **Boot Disk**: 20GB SSD with Claude Code pre-installed
- **Network**: No external IP (egress via Cloud NAT for security)
- **Service Account**: Dedicated `agent-vm@project.iam.gserviceaccount.com` with `roles/datastore.user`
- **Metadata**: Agent ID and User ID (API keys fetched via authenticated endpoint)
- **Labels**: `owner={userId}`, `agent={agentId}`, `managed-by=multitool-workflow-web`

**VM Operations**:
- `suspend`: Preserves memory state, quick resume (~30s)
- `stop`: Discards memory, keeps disk, slower start (~60s)
- `resume`/`start`: Restores VM based on prior state

## GitHub Integration

- **Token Storage**: OAuth access token stored encrypted in `external_auth` collection
- **Rate Limiting**: Exponential backoff with jitter on 403/429 responses
- **Endpoints Used**:
  - `repos.listForAuthenticatedUser`: List user's repositories
  - `issues.listForRepo`: List open issues
  - `repos.listBranches`: List branches

## Security Invariants

1. **Fail closed**: Protected pages redirect to login if Firestore unavailable
2. **Token encryption**: All API keys encrypted with KMS envelope encryption
3. **AAD binding**: Encrypted secrets bound to user ID and tool name
4. **returnTo sanitization**: Only relative paths starting with "/" allowed
5. **Session validation**: Every protected request validates session against Firestore
6. **lastSeenAt throttling**: Updates only if older than 5 minutes
7. **Logout correctness**: Revokes Firestore session FIRST, then destroys cookie
8. **Agent ownership**: All agent operations verify userId matches

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

### Routes

| Route | File | Purpose |
|-------|------|---------|
| `/` | `routes/home.tsx` | Landing page |
| `/agents` | `routes/_app.agents.tsx` | Agent list + new agent form |
| `/agents/:id` | `routes/_app.agents.$id.tsx` | Agent detail view |
| `/settings` | `routes/_app.settings.tsx` | External tool configuration |

## Required Secrets

- `github-client-id` - GitHub OAuth App client ID
- `github-client-secret` - GitHub OAuth App client secret
- `session-secret` - Session cookie signing secret (min 32 chars)

## Required GCP Resources

### KMS
- Keyring: `multitool-workflow-web` (location: `eu-west3`)
- Key: `api-keys` (purpose: ENCRYPT_DECRYPT)
- IAM: Cloud Run SA has `roles/cloudkms.cryptoKeyEncrypterDecrypter`

### Compute Engine
- Service Account: `agent-vm@{project}.iam.gserviceaccount.com`
  - `roles/datastore.user`
- Cloud NAT for outbound internet access
- Custom image with Claude Code pre-installed (or startup script)

### Firestore Indexes
- `users`: `githubId` ASC (for OAuth lookup)
- `external_auth`: `userId` ASC (for listing configured tools)
- `agents`: `userId` ASC, `createdAt` DESC (for listing user's agents)
- `agents`: `userId` ASC, `status` ASC, `updatedAt` DESC (for filtered listing)

## Deployment

- Multi-stage Dockerfile with pnpm
- Cloud Build CI/CD on push to main
- Health check at `/healthz`

## Non-Goals (Part 2)

- Agent conversation/context history (Part 3)
- Real-time agent interaction (Part 3)
- VM reaper/cleanup job (can be added as Cloud Scheduler)
- Additional authentication providers
- User-controlled dark mode toggle
