#!/bin/bash
# CIAS Deployment Script
# Usage: Set CLOUDFLARE_API_TOKEN env var, then run: bash scripts/deploy.sh

set -e

echo "=== CIAS Deployment ==="

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "ERROR: Please set CLOUDFLARE_API_TOKEN environment variable"
  echo "Get your token from: https://dash.cloudflare.com/profile/api-tokens"
  exit 1
fi

echo "Step 1: Deploy Workers backend..."
npx wrangler deploy --config wrangler.toml

echo "Step 2: Deploy Pages frontend..."
cd frontend
npx wrangler pages deploy . --project-name=cias-worker

echo "=== Deployment complete! ==="
echo "Workers: https://cias-worker.<your-subdomain>.workers.dev"
echo "Pages:   https://cias-worker.pages.dev"
