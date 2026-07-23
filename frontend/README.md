# CIAS Frontend - Cloudflare Pages

This is the static frontend for the CIAS dashboard.

## Deploy

```bash
npx wrangler pages deploy . --project-name=cias-dashboard
```

The frontend connects to the CIAS Worker API. Set the API base URL in the `API_BASE` constant in `index.html` if needed.
