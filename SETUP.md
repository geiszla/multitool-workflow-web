# Multitool Workflow Web - Infrastructure Setup Guide

This guide covers all infrastructure setup tasks that must be completed outside of code. The project uses Google Cloud Platform in the `eu-west3` region.

## Prerequisites

- This repo currently assumes the GCP project ID is `multitool-workflow-web` (hardcoded in `app/services/env.server.ts`). If you deploy to a different project, update the code/constants accordingly.
- Google Cloud project created and configured (`multitool-workflow-web`)
- Firestore enabled in Native mode
- `gcloud` CLI installed and authenticated

Recommended shell vars (used throughout this doc):

```bash
export PROJECT_ID="multitool-workflow-web"
export REGION="eu-west3" # sometimes `europe-west3` is used
export ZONE="eu-west3-a"
export SERVICE_NAME="multitool-workflow-web"
export NETWORK="default"
export CONNECTOR_NAME="run-to-vpc"
export CONNECTOR_RANGE="10.8.0.0/28"
export APP_URL="https://YOUR_CLOUD_RUN_URL" # no trailing slash
gcloud config set project "$PROJECT_ID"
gcloud auth application-default set-quota-project "$PROJECT_ID"
```

---

## 0. Enable Required APIs

Enable the Google APIs used by this repo:

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  cloudkms.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  iamcredentials.googleapis.com \
  cloudscheduler.googleapis.com \
  vpcaccess.googleapis.com \
  cloudbuild.googleapis.com \
  pubsub.googleapis.com
```

---

## 0.1 Create Artifact Registry Repository

Create the Docker repository for storing container images:

```bash
gcloud artifacts repositories create multitool-workflow-web \
  --repository-format=docker \
  --location=eu-west3 \
  --description="Docker images for multitool-workflow-web"
```

Grant Cloud Build permission to push to Artifact Registry:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

---

## 1. GitHub OAuth App

Create a GitHub OAuth App for authentication.

### Manual Setup

1. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Configure:
   - **Application name**: `Multitool Workflow Web`
   - **Homepage URL**: `https://your-app-url.run.app`
   - **Authorization callback URL**: `https://your-app-url.run.app/auth/github/callback`
3. Note the **Client ID** and generate a **Client Secret**

---

## 2. Secret Manager Secrets

Store all application secrets in Secret Manager.

```bash
# NOTE: `gcloud secrets create` is one-time; use `gcloud secrets versions add` for updates.
# Tip: avoid putting real secrets directly in your shell history.

# Create required secrets (one-time)
echo -n "YOUR_GITHUB_CLIENT_ID" | gcloud secrets create github-client-id \
  --replication-policy="user-managed" \
  --locations="$REGION" \
  --data-file=-

echo -n "YOUR_GITHUB_CLIENT_SECRET" | gcloud secrets create github-client-secret \
  --replication-policy="user-managed" \
  --locations="$REGION" \
  --data-file=-

# Generate a secure 32+ character session secret (strip trailing newline)
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create session-secret \
  --replication-policy="user-managed" \
  --locations="$REGION" \
  --data-file=-

# Optional: Comped user secrets (organization API keys)
echo -n "YOUR_ORG_CLAUDE_API_KEY" | gcloud secrets create compedClaudeApiKey \
  --replication-policy="user-managed" \
  --locations="$REGION" \
  --data-file=-

echo -n "YOUR_ORG_CODEX_API_KEY" | gcloud secrets create compedCodexApiKey \
  --replication-policy="user-managed" \
  --locations="$REGION" \
  --data-file=-

# Optional: Comped Figma API key
echo -n "YOUR_ORG_FIGMA_API_KEY" | gcloud secrets create compedFigmaApiKey \
  --replication-policy="user-managed" \
  --locations="$REGION" \
  --data-file=-
```

---

## 3. Cloud KMS Setup

Create KMS keyring and key for envelope encryption of user API keys.

```bash
# Create keyring
gcloud kms keyrings create multitool-workflow-web \
  --location="$REGION"

# Create encryption key
gcloud kms keys create api-keys \
  --keyring=multitool-workflow-web \
  --location="$REGION" \
  --purpose=encryption \
  --rotation-period=90d \
  --next-rotation-time=$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)
```

---

## 4. Service Accounts

### 4.1 Cloud Run Service Account

```bash
# Get the default Cloud Run service account (or create a dedicated one)
# Default is: PROJECT_NUMBER-compute@developer.gserviceaccount.com

# Get project number
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CLOUD_RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Or create a dedicated service account
gcloud iam service-accounts create cloud-run-app \
  --display-name="Cloud Run Application"
CLOUD_RUN_SA="cloud-run-app@${PROJECT_ID}.iam.gserviceaccount.com"
```

### 4.2 Agent VM Service Account

```bash
gcloud iam service-accounts create agent-vm \
  --display-name="Agent VM Service Account"
```

### 4.3 Cloud Scheduler Service Account

```bash
gcloud iam service-accounts create scheduler \
  --display-name="Cloud Scheduler Service Account"
```

---

## 5. IAM Permissions

### 5.1 Cloud Run Service Account Permissions

```bash
CLOUD_RUN_SA="cloud-run-app@${PROJECT_ID}.iam.gserviceaccount.com"
# Or use default: CLOUD_RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# KMS Encrypter/Decrypter for API key encryption
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${CLOUD_RUN_SA}" \
  --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"

# Compute Instance Admin for VM management
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${CLOUD_RUN_SA}" \
  --role="roles/compute.instanceAdmin.v1"

# Firestore User for database access
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${CLOUD_RUN_SA}" \
  --role="roles/datastore.user"

# Secret Manager Secret Accessor for retrieving secrets
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${CLOUD_RUN_SA}" \
  --role="roles/secretmanager.secretAccessor"

# Service Account Token Creator for Firebase custom tokens
gcloud iam service-accounts add-iam-policy-binding ${CLOUD_RUN_SA} \
  --member="serviceAccount:${CLOUD_RUN_SA}" \
  --role="roles/iam.serviceAccountTokenCreator"

# REQUIRED: allow Cloud Run to attach the agent-vm service account when creating VMs
gcloud iam service-accounts add-iam-policy-binding \
  "agent-vm@${PROJECT_ID}.iam.gserviceaccount.com" \
  --member="serviceAccount:${CLOUD_RUN_SA}" \
  --role="roles/iam.serviceAccountUser"

# Permissions required for deployment
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/storage.objectViewer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/logging.logWriter"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/artifactregistry.writer"
```

### 5.2 Agent VM Service Account Permissions

```bash
AGENT_VM_SA="agent-vm@${PROJECT_ID}.iam.gserviceaccount.com"

# Firestore User for reporting status
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${AGENT_VM_SA}" \
  --role="roles/datastore.user"
```

### 5.3 Cloud Scheduler Service Account Permissions

```bash
SCHEDULER_SA="scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

# Allow scheduler service account to invoke Cloud Run (run after Cloud Run is deployed)
gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --region="$REGION" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker"

# REQUIRED: allow Cloud Scheduler service agent to mint OIDC tokens as SCHEDULER_SA
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "${SCHEDULER_SA}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

---

## 6. VPC Network and Cloud NAT

VMs use internal IPs only; Cloud NAT provides outbound internet access.

```bash
# NOTE: The current code uses the `default` VPC (see `app/services/compute.server.ts` and `packer/agent-vm.pkr.hcl`).

# Create Cloud Router
gcloud compute routers create agent-router \
  --network="$NETWORK" \
  --region="$REGION"

# Create Cloud NAT
gcloud compute routers nats create agent-nat \
  --router=agent-router \
  --region="$REGION" \
  --nat-all-subnet-ip-ranges \
  --auto-allocate-nat-external-ips
```

---

## 7. Serverless VPC Access (Cloud Run → VM Internal IPs)

The app proxies terminal WebSockets from Cloud Run to the agent VM internal IP (`ws://<internal-ip>:8080`). Cloud Run needs a Serverless VPC Access connector to reach private IPs.

```bash
gcloud compute networks vpc-access connectors create "$CONNECTOR_NAME" \
  --region="$REGION" \
  --network="$NETWORK" \
  --range="$CONNECTOR_RANGE"
```

When deploying/updating Cloud Run, attach the connector with `--vpc-connector="$CONNECTOR_NAME"` (see Cloud Run deployment section).

---

## 8. Firewall Rules

Allow internal traffic to VM PTY server.

```bash
# Allow internal traffic to port 8080 (PTY WebSocket server)
gcloud compute firewall-rules create allow-internal-pty \
  --network="$NETWORK" \
  --direction=INGRESS \
  --priority=1000 \
  --action=ALLOW \
  --rules=tcp:8080 \
  --source-ranges="$CONNECTOR_RANGE" \
  --target-service-accounts="agent-vm@${PROJECT_ID}.iam.gserviceaccount.com" \
  --description="Allow internal traffic to PTY server on agent VMs"
```

---

## 9. Firestore Indexes

Create composite indexes for efficient queries.

```bash
# NOTE: Single-field indexes are created automatically by Firestore.
# Only composite indexes are listed here.

# Agents collection indexes
gcloud firestore indexes composite create \
  --project="$PROJECT_ID" \
  --collection-group=agents \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=createdAt,order=descending

# Agents collection indexes (userId + status filter + createdAt order)
gcloud firestore indexes composite create \
  --project="$PROJECT_ID" \
  --collection-group=agents \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=status,order=ascending \
  --field-config field-path=createdAt,order=descending

# Agents collection indexes (VM reaper): status + lastHeartbeatAt
gcloud firestore indexes composite create \
  --project="$PROJECT_ID" \
  --collection-group=agents \
  --field-config field-path=status,order=ascending \
  --field-config field-path=lastHeartbeatAt,order=ascending

# Sessions collection indexes (revoke all sessions): userId + revokedAt
gcloud firestore indexes composite create \
  --project="$PROJECT_ID" \
  --collection-group=sessions \
  --field-config field-path=userId,order=ascending \
  --field-config field-path=revokedAt,order=ascending
```

Optional (recommended): enable a Firestore TTL policy on the `sessions` collection using the `expiresAt` field for automatic cleanup.

Note: The current shared-agent query uses `where('sharedWith', 'array-contains', userId)` without `orderBy`, so no additional composite index is required. If you later add `orderBy`, Firestore will prompt you to create the needed composite index.

---

## 10. Firebase Setup

Firebase is used for real-time client updates.

### 10.1 Link Firebase to GCP Project

```bash
# Install Firebase CLI if not already installed
npm install -g firebase-tools

# Login and initialize
firebase login
firebase projects:addfirebase "$PROJECT_ID"
```

In Firebase Console, ensure:
- Firestore is enabled (Native mode)
- Firebase Authentication is enabled (custom token sign-in)

### 10.2 Create a Firebase Web App (Required)

The browser uses the Firebase client SDK (see `app/services/firebase.client.ts`). Create a Firebase Web App and configure the client SDK.

1. **Create Firebase Web App** in Firebase Console:
   - Go to Project Settings > General > Your apps
   - Click "Add app" > Web (</>) icon
   - Register app with a nickname (e.g., "Multitool Web")
   - Copy the `firebaseConfig` object from the setup instructions

2. **Configure environment variables** in `.env.production`:

   ```bash
   # Firebase Client Configuration (public, baked into client bundle)
   VITE_FIREBASE_API_KEY=your-api-key
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
   VITE_FIREBASE_APP_ID=1:123456789:web:abcdef123456
   ```

   These values are *public configuration* (not secrets). They are baked into the client bundle during `pnpm build` and used by `app/services/firebase.client.ts`.

3. **For local development**, copy the same values to `.env`:

   ```bash
   cp .env.production .env
   # Edit .env as needed for local development
   ```

**Important**: If these values are missing or incorrect, real-time updates will not work (the client cannot connect to Firebase).

### 10.3 Deploy Firestore Security Rules

If this repo hasn’t been initialized for Firebase yet, do it once:

```bash
firebase init firestore
```

Create/update the `firestore.rules` file:

```firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /agents/{agentId} {
      allow read: if request.auth != null
        && (
          resource.data.userId == request.auth.uid
          || (resource.data.sharedWith is list && request.auth.uid in resource.data.sharedWith)
        );
      allow write: if false;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Deploy the rules:

```bash
firebase deploy --only firestore:rules --project "$PROJECT_ID"
```

---

## 11. Cloud Scheduler - VM Reaper

Automated cleanup of inactive VMs.

```bash
# Create the reaper scheduler job
gcloud scheduler jobs create http agent-vm-reaper \
  --location="$REGION" \
  --schedule="*/5 * * * *" \
  --uri="${APP_URL}/api/internal/reaper" \
  --http-method=POST \
  --oidc-service-account-email="scheduler@${PROJECT_ID}.iam.gserviceaccount.com" \
  --oidc-token-audience="${APP_URL}/api/internal/reaper" \
  --description="Clean up inactive agent VMs every 5 minutes"
```

---

## 12. VM Image Build Pipeline

Automated weekly builds of VM images with pre-installed dependencies.

### 12.1 Create Pub/Sub Topic for Build Triggers

```bash
gcloud pubsub topics create packer-build-trigger
```

### 12.2 Create Cloud Build Trigger

```bash
gcloud builds triggers create pubsub \
  --name=build-vm-image \
  --topic="projects/${PROJECT_ID}/topics/packer-build-trigger" \
  --build-config=cloudbuild-packer.yaml \
  --region="$REGION"
```

### 12.3 Create Weekly Scheduler Job

```bash
gcloud scheduler jobs create pubsub weekly-vm-image-build \
  --location="$REGION" \
  --schedule="0 2 * * 0" \
  --time-zone="UTC" \
  --topic=packer-build-trigger \
  --message-body='{"trigger": "scheduled"}' \
  --description="Weekly VM image rebuild (Sundays 02:00 UTC)"
```

### 12.4 Grant Cloud Build Permissions

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CLOUD_BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

# Compute Admin for creating images
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/compute.admin"

# Service Account User for using the agent-vm service account
gcloud iam service-accounts add-iam-policy-binding \
  "agent-vm@${PROJECT_ID}.iam.gserviceaccount.com" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/iam.serviceAccountUser"

# Allow Cloud Scheduler service agent to publish to Pub/Sub for weekly image builds
gcloud pubsub topics add-iam-policy-binding packer-build-trigger \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

---

## 13. Cloud Run Deployment

### 13.1 Initial Deployment

```bash
# Build and deploy
gcloud run deploy "$SERVICE_NAME" \
  --source=. \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --service-account="cloud-run-app@${PROJECT_ID}.iam.gserviceaccount.com" \
  --vpc-connector="$CONNECTOR_NAME" \
  --vpc-egress=private-ranges-only \
  --set-env-vars="NODE_ENV=production,APP_URL=https://YOUR_FINAL_URL,REAPER_AUDIENCE=https://YOUR_FINAL_URL/api/internal/reaper,SCHEDULER_SERVICE_ACCOUNT_EMAIL=scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
```

### 13.2 Enable WebSocket Support

WebSocket support is enabled by default on Cloud Run. Enable session affinity if needed:

```bash
gcloud run services update "$SERVICE_NAME" \
  --region="$REGION" \
  --session-affinity
```

---

## 14. Cloud Build CI/CD (Optional)

Set up automatic deployment on push to main.

Note: If you deploy via `cloudbuild.yaml`, ensure its `gcloud run deploy` step includes the same `--service-account`, `--vpc-connector`, `--vpc-egress`, and required env vars as the manual deploy command above.

```bash
# Connect repository (interactive)
gcloud builds triggers create github \
  --name=deploy-on-push \
  --repo-owner=YOUR_GITHUB_ORG \
  --repo-name=multitool-workflow-web \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml \
  --region="$REGION"
```

---

## 15. Environment Variables Summary

Set these environment variables for Cloud Run:

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `production` |
| `APP_URL` | Your Cloud Run URL |
| `REAPER_AUDIENCE` | `${APP_URL}/api/internal/reaper` |
| `SCHEDULER_SERVICE_ACCOUNT_EMAIL` | `scheduler@${PROJECT_ID}.iam.gserviceaccount.com` |
| `AGENT_SOURCE_IMAGE` | (Optional) Pin to specific image for rollback |

---

## 16. Verification Checklist

After completing setup, verify:

- [ ] `gcloud kms keys list --keyring=multitool-workflow-web --location=$REGION` shows `api-keys`
- [ ] `gcloud secrets list` shows all required secrets
- [ ] `gcloud iam service-accounts list` shows `agent-vm` and `scheduler` accounts
- [ ] `gcloud compute routers nats list --router=agent-router --region=$REGION` shows NAT config
- [ ] `gcloud compute firewall-rules list` shows `allow-internal-pty`
- [ ] `gcloud scheduler jobs list --location=$REGION` shows `agent-vm-reaper` and `weekly-vm-image-build`
- [ ] Cloud Run service is deployed and accessible
- [ ] Firebase is linked and security rules deployed
- [ ] GitHub OAuth callback URL matches Cloud Run URL

---

## 17. Manual Build Trigger

To manually trigger a VM image build:

```bash
./scripts/build-vm-image.sh
```

Or publish directly to Pub/Sub:

```bash
gcloud pubsub topics publish packer-build-trigger --message='{"trigger": "manual"}'
```

---

## 18. Rollback Procedure

To roll back to a specific VM image:

```bash
gcloud run services update "$SERVICE_NAME" \
  --region="$REGION" \
  --set-env-vars="AGENT_SOURCE_IMAGE=projects/${PROJECT_ID}/global/images/multitool-agent-YYYYMMDD"
```

To return to latest image, remove the env var:

```bash
gcloud run services update "$SERVICE_NAME" \
  --region="$REGION" \
  --remove-env-vars=AGENT_SOURCE_IMAGE
```
