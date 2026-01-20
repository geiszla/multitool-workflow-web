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

## WebSocket Architecture (Part 3)

Two separate communication channels for optimal performance and reliability:

1. **Firestore Realtime**: Agent status, lifecycle events, activity indicators
   - Uses Firebase client SDK with custom tokens
   - Automatic reconnection and offline support
   - No server polling needed

2. **WebSocket**: Terminal stream only
   - Direct bidirectional communication for low latency
   - Typed message protocol (stdin, stdout, resize, ping/pong, error, exit)
   - Cloud Run handles WebSocket upgrades via custom server

### WebSocket Message Protocol

```typescript
type WSMessage
  = | { type: 'stdin', data: string }
    | { type: 'stdout', data: string }
    | { type: 'resize', cols: number, rows: number }
    | { type: 'ping' }
    | { type: 'pong' }
    | { type: 'error', message: string }
    | { type: 'exit', code: number }
```

## WebSocket Security

**Origin Validation (CSRF Protection)**:
- Validates Origin header on WebSocket upgrade requests
- Rejects if Origin doesn't match allowed origins (fail closed)
- Prevents Cross-Site WebSocket Hijacking (CSWSH)

**Session-based Authorization**:
- Parses session cookie on WebSocket upgrade
- Verifies session is valid and not expired
- Confirms user owns the requested agent

**SSRF Prevention**:
- VM IP resolved server-side from Firestore (not from client)
- `internalIp` field never exposed to browser

## Terminal Emulation

**Browser (xterm.js)**:
- Full terminal emulation with ANSI escape codes
- Auto-fit to container size
- Clickable URLs (web-links addon)
- Reconnection with exponential backoff

**VM (PTY Server)**:
- WebSocket server on port 8080 (internal only)
- node-pty for PTY process management
- Spawns Claude Code CLI in PTY
- Health check endpoint at `/health`

## VM Startup Flow

Uses systemd services for reliable orchestration:

1. **Startup Script** (runs on VM boot):
   - Installs Node.js, git, Claude Code CLI
   - Writes systemd unit files
   - Enables and starts services

2. **agent-bootstrap.service** (oneshot):
   - Fetches credentials via GCE instance identity token
   - Reports internal IP to Cloud Run
   - Clones repository with GitHub token
   - Updates status to 'running' on success

3. **pty-server.service** (long-running):
   - Waits for bootstrap to complete
   - Starts WebSocket server on :8080
   - Spawns Claude Code in PTY
   - Reports `terminalReady: true`

## Credential Flow

**VM to Cloud Run Authentication**:
1. VM requests identity token from GCE metadata server
2. Token audience set to Cloud Run URL
3. Cloud Run verifies token with Google's OAuth2 endpoint
4. Claims extracted for service account and instance validation

**Credentials Endpoint** (`/api/agents/:id/credentials`):
- Returns GitHub token, Claude API key, Codex API key
- Validates GCE identity token
- Verifies agent status is provisioning/running
- Credentials not cached on VM disk (in-memory only)

## Inactivity Timeout

**Two-stage timeout system**:
1. **15 minutes inactive**: Suspend VM (preserves memory, ~30s resume)
2. **1 hour inactive**: Stop VM (discards memory, ~60s restart)

**Implementation**:
- Browser tracks activity (keydown, mouse events)
- Updates `lastActivity` in Firestore every 30 seconds
- Shows warnings 2 min before suspend, 5 min before stop
- Pauses timer when tab is hidden
- Server backup (future): Cloud Scheduler checks `lastActivity`

**Warning States**:
- `active`: Normal operation
- `warning-suspend`: 2 min before suspend
- `warning-stop`: 5 min before stop (after resumed from suspend)
- `suspending`: Suspend action in progress
- `stopping`: Stop action in progress

## Resume Modes

**From Suspended (fast)**:
- VM memory preserved
- ~30 second resume time
- Terminal session continues

**From Stopped (slow)**:
- VM boots fresh, disk preserved
- ~60 second start time
- Uses Claude Code `--resume` flag for conversation continuity
- `needsResume: true` flag stored in Firestore

## Firebase Realtime Integration

**Custom Token Generation**:
- Server generates Firebase custom token using IAM signBlob API
- Token UID matches internal user ID
- 1-hour expiry, Firebase SDK auto-refreshes

**Client Setup**:
1. Fetch token from `/api/auth/firebase-token`
2. `signInWithCustomToken()` authenticates Firebase client
3. `onSnapshot()` subscribes to agent document changes

**Firestore Security Rules**:
```javascript
match /agents/{agentId} {
  allow read: if request.auth != null &&
    resource.data.userId == request.auth.uid;
  allow write: if false; // Server-only writes
}
```

## Extended Data Model (Part 3)

New fields in `agents/{agentId}`:
- `internalIp`: VM internal IP (server-side only)
- `terminalPort`: WebSocket port (default 8080)
- `lastActivity`: Last user activity timestamp
- `terminalReady`: True when PTY server is ready
- `cloneStatus`: 'pending' | 'cloning' | 'completed' | 'failed'
- `cloneError`: Clone error message if failed
- `needsResume`: True if stopped, needs --resume flag
- `provisioningOperationId`: GCE operation ID for polling

## API Endpoints (Part 3)

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/agents/:id/credentials` | GET | GCE Identity | VM fetches credentials |
| `/api/agents/:id/status` | GET/POST | GCE Identity | VM reports status |
| `/api/agents/:id/activity` | POST | Session | Browser reports activity |
| `/api/agents/:id/terminal` | WebSocket | Origin + Session | Terminal proxy |
| `/api/auth/firebase-token` | GET | Session | Get Firebase custom token |

## Non-Goals (Part 2/3)

- Terminal history persistence (ephemeral for MVP)
- Retry failed agents (future issue)
- Multi-tab support (single session per agent)
- GitHub App integration (keep OAuth)
- Server-side inactivity scheduler (future enhancement)
- Additional authentication providers
- User-controlled dark mode toggle
