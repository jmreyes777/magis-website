# Magis Edge Worker

Cloudflare Worker for the Magis website project.

## Setup

This edge worker is set up without the Wrangler CLI due to platform compatibility issues. It will need to be deployed manually via the Cloudflare dashboard.

## Configuration

Update the `.env` file with your actual URLs and secrets:
- ADMIN_URL: Your admin frontend URL
- GUEST_URL: Your user frontend URL  
- BACKEND_URL: Your backend API URL
- JWT_SECRET: Your JWT secret key

## Deployment via Cloudflare Dashboard

1. Go to https://dash.cloudflare.com/
2. Select your account and domain
3. Go to Workers & Pages
4. Create a new Worker
5. Copy the contents of `index.js` into the Quick Edit editor
6. Add the environment variables in Settings > Variables and Secrets
7. Deploy the worker
8. Set up routes/triggers in your domain settings

## Features

- Security headers (HSTS, CSP, X-Frame-Options, etc.)
- CORS handling
- Basic routing and proxying
- Rate limiting ready (requires KV namespace)

## Dependencies

- jose: JWT verification
- jsonschema: Schema validation

## Notes

- This is a basic structure that can be expanded based on the original implementation
- Full implementation from the original project can be copied from Google Drive if needed
- Some advanced features may require additional Cloudflare bindings
