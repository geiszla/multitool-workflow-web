# Multitool Workflow Web

A cloud-based web interface for the [multitool-workflow](https://github.com/geiszla/multitool-workflow) project. This application allows users to run AI-assisted workflows on GitHub repositories through an authenticated web interface.

## Prerequisites

- **Node.js 24 LTS** (see `.node-version`)
- **pnpm**
- **Google Cloud SDK**

## Quick Start

### 1. Install Dependencies

```bash
# Install pnpm if not already installed
npm install -g pnpm

# Install project dependencies
pnpm install
```

### 2. Authenticate with Google Cloud

```bash
# Authenticate for local development
gcloud auth application-default login

# Set your project
gcloud config set project multitool-workflow-web
```

### 3. Start Development Server

```bash
pnpm dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Using Firestore Emulator (Recommended for Development)

For local development, you can use the Firestore emulator instead of a real Firestore database:

```bash
# Install Firebase CLI if needed
pnpm install -g firebase-tools

# Start the Firestore emulator
firebase emulators:start --only firestore

# In another terminal, set the emulator host before starting the app
export FIRESTORE_EMULATOR_HOST=localhost:8080
pnpm dev
```

## Project Structure

```txt
app/
  routes/           # React Router routes (pages and API endpoints)
  components/       # React components
    layout/         # Layout components (Header, Sidebar, etc.)
  services/         # Server-side services
  models/           # Data models and Firestore operations
```

## Available Scripts

| Command | Description |
| ------- | ----------- |
| `pnpm dev` | Start development server |
| `pnpm build` | Build for production |
| `pnpm start` | Start production server |
| `pnpm lint` | Run ESLint |
| `pnpm typecheck` | Run TypeScript type checking |

## Deployment

This application is designed to run on Google Cloud Run. See the deployment configuration files:

- `Dockerfile` - Multi-stage Docker build
- `cloudbuild.yaml` - Cloud Build CI/CD configuration

See `OVERVIEW.md` for detailed architecture and deployment documentation.

### Docker Deployment

To build and run using Docker:

```bash
docker build -t my-app .

# Run the container (note: the app runs on port 8080 inside the container)
docker run -p 3000:8080 -e APP_URL=http://localhost:3000 my-app
```

## Security

- OAuth with state validation for CSRF protection (via arctic library)
- Sessions are stored server-side in Firestore
- Cookie contains session ID; user data is fetched from Firestore on each request
- Cookies are httpOnly, secure, and sameSite=lax
- Fail-closed security: if Firestore is unavailable, users are redirected to login
- Secrets are managed via Google Cloud Secret Manager

## License

Private - All rights reserved.
