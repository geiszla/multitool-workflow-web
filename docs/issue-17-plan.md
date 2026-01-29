# Implementation Plan - Issue #17: Fix Review Findings (Round 3)

**Issue**: https://github.com/geiszla/multitool-workflow-web/issues/17
**Status**: Draft Plan v2 (Codex-refined)
**Created**: 2026-01-28

---

## Scope & Goals

This issue addresses review findings from Round 3, including:
- **Deployment Breakers**: Critical GCP configuration issues that would break deployment
- **VM Provisioning/Lifecycle Bugs**: Race conditions and cost leak issues
- **Workflow/Plugin Wiring Gaps**: Missing CLI tools and workflow inconsistencies
- **Other Risks**: WebSocket error handling and documentation inconsistencies

---

## Technical Decisions (from Codex Review)

1. **GCP Region**: Canonical region is `europe-west3`, zone is `europe-west3-a`
2. **VPC Connector**: Use `run-to-vpc` as the connector name (confirmed by user)
3. **Scheduler SA**: Use `scheduler@${PROJECT_ID}.iam.gserviceaccount.com`
4. **Secrets Strategy**: Keep app reading from Secret Manager directly, remove unused `--set-secrets`
5. **Bootstrap done marker**: Make status update a hard requirement - only write marker after successful status transition
6. **VM cleanup**: Only attempt deletion when instanceName/instanceZone are known
7. **Pinned image retention**: Keep pinned + last 5 non-pinned images (pinned doesn't count toward 5)
8. **WebSocket errors**: Use IIFE + .catch() pattern, call ws.close() on failures

---

## Issue Summary

### Category 1: Likely Deployment Breakers (CRITICAL)

1. **GCP Location Format Error** - Using AWS-style region names (`eu-west3`) instead of GCP style (`europe-west3`)
   - Files: `app/services/compute.server.ts:17`, `packer/variables.pkr.hcl:17`, `app/services/kms.server.ts:21`, `cloudbuild.yaml:10,36`, `cloudbuild-packer.yaml:27`
   - Impact: VM creation, Packer builds, KMS, and Cloud Run deploy will fail

2. **Cloud Run Deploy Args Mismatch** - `cloudbuild.yaml` settings don't match `SETUP.md`
   - Missing `--service-account` flag
   - VPC connector uses wrong name (`cloud-run-connector` should be `run-to-vpc`)
   - Scheduler SA email uses wrong name (`scheduler-invoker@` should be `scheduler@`)
   - Files: `cloudbuild.yaml:41,49`, `app/services/reaper.server.ts:61`

3. **Unused Secrets Env Vars** - App reads secrets from Secret Manager directly, but `cloudbuild.yaml` sets `--set-secrets` env vars that aren't used
   - Files: `cloudbuild.yaml:50`, `app/services/secrets.server.ts:43`

### Category 2: VM Provisioning/Lifecycle Bugs

4. **Bootstrap "Done" Marker Race Condition** - Writes done marker before confirming agent status transition
   - If the final status update fails, bootstrap won't rerun and agent stuck in provisioning
   - File: `vm-bootstrap/bootstrap.js:247`

5. **VM Failure Cost Leak** - VM provisioning failure marks agent as failed but doesn't stop/delete the instance
   - File: `app/routes/_app.agents.tsx:205`

### Category 3: Workflow/Plugin Wiring Gaps

6. **Missing `gh` CLI in VM Image** - Workflow needs `gh` as fallback but it's not installed
   - Files: `multitool-workflow/commands/github-workflow.md`, `packer/scripts/provision.sh:24`

7. **Resume Boot Workflow Re-run** - Resume always starts with both `--continue` and workflow command
   - May cause unexpected behavior or re-run workflow
   - File: `vm-bootstrap/pty-server.js:141`

8. **Image Cleanup May Delete Pinned Rollback Images** - Cleanup doesn't check for pinned images
   - Request: Exclude pinned images from deletion
   - File: `cloudbuild-packer.yaml:55`

### Category 4: Other Notable Risks

9. **WebSocket Async Error Handling** - Async callback in `wss.handleUpgrade()` lacks error handling
   - File: `server.ts:106`

10. **Documentation Inconsistencies** - `OVERVIEW.md` describes non-existent endpoints/statuses
    - Non-existent: `cancelled/completed` statuses, `/api/agents/:id/activity` endpoint
    - File: `OVERVIEW.md`

11. **Unused Heartbeat Route** - `/api/agents/:id/heartbeat` route is no longer used
    - File: `app/routes/api.agents.$id.heartbeat.tsx`

---

## Architecture Impact

### Files to Change
1. `app/services/compute.server.ts` - Fix GCP region
2. `packer/variables.pkr.hcl` - Fix GCP zone
3. `app/services/kms.server.ts` - Fix KMS location
4. `cloudbuild.yaml` - Fix region, VPC connector, service account, secrets handling
5. `cloudbuild-packer.yaml` - Fix zone, exclude pinned images from cleanup
6. `vm-bootstrap/bootstrap.js` - Fix race condition with done marker
7. `app/routes/_app.agents.tsx` - Add VM cleanup on provisioning failure
8. `packer/scripts/provision.sh` - Install gh CLI
9. `vm-bootstrap/pty-server.js` - Fix resume workflow logic
10. `server.ts` - Add error handling to WebSocket upgrade
11. `OVERVIEW.md` - Fix documentation inconsistencies
12. `SETUP.md` - Update to match actual deployment configuration
13. `app/routes/api.agents.$id.heartbeat.tsx` - DELETE (unused)

### Data Model Changes
- None required

### External System Integration Changes
- GCP region change from `eu-west3` to `europe-west3` across all services

---

## Task Breakdown

### Task 1: Fix GCP Region Format (CRITICAL - Deployment Breaker)

**Purpose**: Change all GCP region/zone references from AWS-style (`eu-west3`) to GCP-style (`europe-west3`)

**Target files and changes**:
- `app/services/compute.server.ts:17`: Change `DEFAULT_ZONE = 'eu-west3-a'` to `'europe-west3-a'`
- `packer/variables.pkr.hcl:17`: Change `default = "eu-west3-a"` to `"europe-west3-a"`
- `app/services/kms.server.ts:21`: Change `KMS_LOCATION = 'eu-west3'` to `'europe-west3'`
- `cloudbuild.yaml`: Change ALL occurrences of `eu-west3` to `europe-west3`:
  - Line 10, 12: Artifact Registry hostname
  - Line 34: Artifact Registry hostname in deploy
  - Line 36: `--region` flag
  - Line 42: VPC connector path
  - Line 69: images section
- `cloudbuild-packer.yaml:27`: Change `zone=eu-west3-a` to `zone=europe-west3-a`

**Tests**: Manual deployment verification (Cloud Build will validate)
**Validation**: Run `grep -r "eu-west3" --include="*.ts" --include="*.yaml" --include="*.hcl"` to verify no stale references

**Risk**: HIGH - Must be consistent across all files or deployment will fail

---

### Task 2: Fix cloudbuild.yaml Deployment Configuration

**Purpose**: Align Cloud Run deployment with SETUP.md requirements

**Target files and changes**:
- `cloudbuild.yaml`:
  - Add `--service-account` flag: `--service-account=cloud-run-app@$PROJECT_ID.iam.gserviceaccount.com`
  - Change VPC connector from `cloud-run-connector` to `run-to-vpc`
  - Change scheduler SA from `scheduler-invoker@` to `scheduler@`
  - Remove `--set-secrets` line (app reads from Secret Manager directly)

**Tests**: Manual deployment verification

**Risk**: MEDIUM - Service account and connector mismatch could affect permissions and connectivity

---

### Task 3: Fix Bootstrap Race Condition

**Purpose**: Ensure status update completes successfully before writing done marker

**Target files and changes**:
- `vm-bootstrap/bootstrap.js`:
  - Modify `updateStatus()` to return success/failure (check HTTP status)
  - Move status update BEFORE writing the done marker
  - Only write done marker if status update succeeds
  - If status update fails, exit with error (don't write marker)

**Implementation detail**:
```javascript
// Modify updateStatus to return success/failure
async function updateStatus(updates) {
  log('info', 'Updating agent status', updates)
  const token = await getIdentityToken()
  const url = `${CLOUD_RUN_URL}/api/agents/${AGENT_ID}/status`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  })

  if (!response.ok) {
    const text = await response.text()
    log('error', `Failed to update status: ${response.status} ${text}`)
    return false
  }
  return true
}

// In main():
// First: transition to running
const statusUpdated = await updateStatus({ status: 'running' })
if (!statusUpdated) {
  throw new Error('Failed to update agent status to running')
}
// Only after success: write done marker
writeFileSync(join(STATE_DIR, 'done'), new Date().toISOString(), { mode: 0o600 })
```

**Tests**: Manual test - simulate status update failure, verify bootstrap re-runs

**Risk**: MEDIUM - Status update must succeed or bootstrap will exit with error and retry on next boot

---

### Task 4: Fix VM Cost Leak on Provisioning Failure

**Purpose**: Stop/delete VM instance when provisioning fails to prevent cost leak

**Target files and changes**:
- `app/routes/_app.agents.tsx:205-231`:
  - Import `deleteInstance` from compute.server.ts
  - After marking agent as failed, check if instanceName/instanceZone exist
  - If they exist, attempt best-effort `deleteInstance()` with try/catch
  - Log cleanup result but don't throw on cleanup failure

**Implementation detail**:
```typescript
// After updating agent status to failed:
// Also import: import { deleteInstance } from '~/services/compute.server'

// Attempt to clean up the VM to prevent cost leak
const currentAgent = await getAgent(agent.id)
if (currentAgent?.instanceName && currentAgent?.instanceZone) {
  try {
    await deleteInstance(currentAgent.instanceName, currentAgent.instanceZone)
    console.log(`Cleaned up VM ${currentAgent.instanceName} after provisioning failure`)
  } catch (cleanupError) {
    // Log but don't fail - the agent status update already succeeded
    console.error('Failed to cleanup VM after provisioning failure:', cleanupError)
  }
}
```

**Tests**: Manual test - create agent with intentionally failing config, verify VM is deleted

**Risk**: LOW - Defensive cleanup, deleteInstance is already idempotent (404 = success)

---

### Task 5: Install gh CLI in VM Image

**Purpose**: Add GitHub CLI to VM image for workflow fallback

**Target files and changes**:
- `packer/scripts/provision.sh`:
  - Add installation of `gh` CLI using official Debian installation method
  - Add verification step to confirm installation

**Implementation detail**:
```bash
# Install GitHub CLI (official Debian method)
echo "Installing GitHub CLI..."
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
  gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
  tee /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y gh
echo "GitHub CLI version: $(gh --version)"
```

**Tests**: Rebuild VM image and verify `gh --version` works

**Risk**: LOW - Additional package, doesn't affect existing functionality

---

### Task 6: Fix Resume Workflow Logic

**Purpose**: Prevent re-running workflow on resume boots

**Target files and changes**:
- `vm-bootstrap/pty-server.js:136-155`:
  - Restructure the logic so `needsContinue` and workflow command are mutually exclusive
  - When `needsContinue` is true, only use `--continue` flag (no workflow command)
  - Only add workflow command for fresh starts (no needsContinue)

**Implementation detail**:
```javascript
// Build Claude Code command
const claudeArgs = [
  `--allowedTools=${allowedTools.join(',')}`,
  '--plugin-dir=/opt/multitool-workflow',
]

// MUTUALLY EXCLUSIVE: either resume with --continue OR start fresh with workflow
if (credentials && credentials.needsContinue) {
  // Resume: only use --continue, do NOT re-run workflow
  claudeArgs.push('--continue')
} else if (credentials && credentials.issueNumber) {
  // Fresh start: add workflow command
  const issueUrl = `https://github.com/${credentials.repoOwner}/${credentials.repoName}/issues/${credentials.issueNumber}`
  claudeArgs.push('/multitool-workflow:github-workflow')
  claudeArgs.push(issueUrl)
  if (credentials.instructions) {
    claudeArgs.push(credentials.instructions)
  }
}
```

**Tests**: Manual test - stop agent, restart, verify workflow doesn't re-run

**Risk**: MEDIUM - Behavioral change, but correct according to Claude Code semantics

---

### Task 7: Exclude Pinned Images from Cleanup

**Purpose**: Protect rollback images from being deleted by cleanup process

**Target files and changes**:
- `cloudbuild-packer.yaml:55-71`:
  - Fetch the pinned image name from Cloud Run service config (if AGENT_SOURCE_IMAGE is set)
  - Extract image basename if it's a full resource path
  - Keep pinned image + last 5 non-pinned (pinned doesn't count toward 5)
  - Skip deletion if image matches pinned image name

**Implementation detail**:
```bash
# Get pinned image from Cloud Run service env (if any)
PINNED_IMAGE=$(gcloud run services describe multitool-workflow-web \
  --region=europe-west3 \
  --format='value(spec.template.spec.containers[0].env[AGENT_SOURCE_IMAGE])' 2>/dev/null || echo "")

# Extract image name from full path if needed (e.g., projects/.../images/NAME -> NAME)
if [ -n "$PINNED_IMAGE" ]; then
  PINNED_IMAGE_NAME=$(basename "$PINNED_IMAGE")
else
  PINNED_IMAGE_NAME=""
fi

# Filter out pinned image from deletion candidates
echo "$IMAGES" | head -n "$DELETE_COUNT" | while read -r IMAGE; do
  if [ -n "$IMAGE" ] && [ "$IMAGE" != "$PINNED_IMAGE_NAME" ]; then
    echo "Deleting image: $IMAGE"
    gcloud compute images delete "$IMAGE" --quiet || true
  else
    echo "Skipping pinned image: $IMAGE"
  fi
done
```

**Tests**: Verify cleanup works and pinned images are preserved

**Risk**: LOW - Additive protection, worst case is extra images kept

---

### Task 8: Add WebSocket Upgrade Error Handling

**Purpose**: Handle errors in async callback of wss.handleUpgrade() to prevent unhandled rejections

**Target files and changes**:
- `server.ts:106-117`:
  - Wrap the async callback body in try/catch
  - Log errors and close WebSocket gracefully on failure
  - Use proper error codes

**Implementation detail**:
```typescript
wss.handleUpgrade(request, socket, head, (ws) => {
  // Use IIFE + catch to handle async errors properly
  (async () => {
    try {
      const result = await setupProxyConnection(ws, request, agentId)
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }))
        ws.close(result.errorCode || 1008, result.error)
      }
    } catch (error) {
      console.error('WebSocket setup error:', error)
      try {
        ws.close(1011, 'Internal server error')
      } catch {
        // Ignore close errors
      }
    }
  })()
})
```

**Tests**: Manual test - verify error handling works, no unhandled rejections in logs

**Risk**: LOW - Defensive error handling

---

### Task 9: Remove Unused Heartbeat Route

**Purpose**: Delete the unused `/api/agents/:id/heartbeat` endpoint

**Target files and changes**:
- `app/routes/api.agents.$id.heartbeat.tsx`: DELETE entire file

**Verification**: Search codebase for references to this endpoint:
- `grep -r "heartbeat" --include="*.ts" --include="*.tsx" --include="*.js"`
- Verify no code calls this endpoint

**Tests**: Build succeeds without the file

**Risk**: LOW - Removing unused code

---

### Task 10: Fix Documentation Inconsistencies

**Purpose**: Update OVERVIEW.md to match actual implementation

**Target files and changes**:
- `OVERVIEW.md`:
  - Remove `/api/agents/:id/activity` from endpoint list (line ~460, doesn't exist)
  - Remove `/api/agents/:id/heartbeat` from endpoint list (being deleted)
  - Update GCP region references from `eu-west3` to `europe-west3`
  - Verify status machine documentation is correct (no cancelled/completed - already correct)

**Tests**: None (documentation only)

**Risk**: LOW - Documentation update

---

### Task 11: Update SETUP.md for Consistency

**Purpose**: Ensure SETUP.md matches actual deployment configuration

**Target files and changes**:
- `SETUP.md`:
  - Update `REGION="eu-west3"` to `REGION="europe-west3"` (line ~17)
  - Update `ZONE="eu-west3-a"` to `ZONE="europe-west3-a"` (line ~18)
  - Update all gcloud commands that reference the region
  - Verify VPC connector name is `run-to-vpc` (already correct)
  - Verify scheduler SA is `scheduler@` (already correct)

**Tests**: None (documentation only)

**Risk**: LOW - Documentation update

---

### Task 12: Final Validation

**Purpose**: Verify all changes are consistent and no stale references remain

**Validation steps**:
1. `npm run typecheck` - Ensure TypeScript compiles
2. `npm run build` - Ensure app builds
3. `grep -r "eu-west3" --include="*.ts" --include="*.tsx" --include="*.yaml" --include="*.hcl" --include="*.md"` - No stale region references
4. `grep -r "scheduler-invoker" --include="*.yaml"` - No stale scheduler SA references
5. `grep -r "cloud-run-connector" --include="*.yaml"` - No stale connector references

---

## Risk Areas & Watch-outs

1. **GCP Region Migration**: All files must be updated consistently or deployment fails
2. **Bootstrap Race Condition**: Status update must succeed before marker is written
3. **Resume Logic**: Behavioral change may affect existing resumed agents
4. **VM Cleanup**: Must not throw errors that break the overall provisioning flow

---

## Package/Library Strategy

No new packages needed. Using:
- GitHub CLI (`gh`) - official GitHub CLI, well-maintained
- Existing GCP client libraries

---

## Resolved Questions

1. **VPC connector name**: `run-to-vpc` (confirmed by user)
2. **Scheduler SA email**: `scheduler@${PROJECT_ID}.iam.gserviceaccount.com` (from SETUP.md)
3. **Pinned image retention**: Keep pinned + last 5 non-pinned
4. **Secrets strategy**: Keep app reading from Secret Manager, remove unused `--set-secrets`
