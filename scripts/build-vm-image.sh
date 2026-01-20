#!/bin/bash
# Build VM image using Cloud Build
#
# Usage: ./scripts/build-vm-image.sh [--project PROJECT_ID]
#
# This script submits a Cloud Build job to build the agent VM image
# using Packer. The image will be added to the 'multitool-agent' family.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-multitool-workflow-web}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--project PROJECT_ID]"
      echo ""
      echo "Build agent VM image using Cloud Build and Packer."
      echo ""
      echo "Options:"
      echo "  --project PROJECT_ID  GCP project ID (default: multitool-workflow-web)"
      echo "  --help, -h            Show this help message"
      echo ""
      echo "Environment variables:"
      echo "  PROJECT_ID            Alternative way to set project ID"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

echo "=== Building VM image ==="
echo "Project: $PROJECT_ID"
echo ""

# Verify gcloud auth
if ! gcloud auth print-identity-token &>/dev/null; then
  echo "Error: Not authenticated. Run 'gcloud auth login' first."
  exit 1
fi

# Verify project access
if ! gcloud projects describe "$PROJECT_ID" &>/dev/null; then
  echo "Error: Cannot access project '$PROJECT_ID'. Check permissions."
  exit 1
fi

# Submit build
echo "Submitting Cloud Build job..."
BUILD_ID=$(gcloud builds submit \
  --project="$PROJECT_ID" \
  --config=cloudbuild-packer.yaml \
  --async \
  --format='value(id)')

echo ""
echo "Build submitted successfully!"
echo "Build ID: $BUILD_ID"
echo ""
echo "View build:"
echo "  https://console.cloud.google.com/cloud-build/builds/$BUILD_ID?project=$PROJECT_ID"
echo ""

# Optionally wait for build
read -p "Wait for build to complete? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo ""
  echo "Streaming build logs..."
  gcloud builds log "$BUILD_ID" --project="$PROJECT_ID" --stream
fi
