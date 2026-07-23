# Facebook Ads Automation Dashboard

A Node.js/Express dashboard for creating and managing Facebook ad campaigns across multiple accounts, with Gemini AI for generating ad copy variations.

## Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS (served as static files from `public/`)
- **Storage**: Local ignored `config/storage.local.json` (no external database)
- **APIs**: Facebook Graph API, Google Gemini API

## How to run

```
node server.js
```

Runs on port 5000. The workflow `Start application` is pre-configured.

## Configuration

API credentials are configured through the in-app **Settings** page and stored only in the ignored local runtime file:

- **Facebook App ID** — from your Facebook Developer app
- **Facebook App Secret** — from your Facebook Developer app
- **Facebook Access Token** — per ad account (added on the Accounts page)
- **Gemini API Key** — from Google AI Studio

## Project structure

```
server.js          # Express entry point
routes/            # API route handlers (accounts, campaigns, settings)
services/          # facebook.js and gemini.js API clients
public/            # Static frontend (index.html, css/, js/)
config/            # storage.example.json (safe template); storage.local.json is runtime-only
uploads/           # Temp storage for media uploads (auto-created)
```

## User preferences

- Keep the existing stack and structure
