# Man-Ai — Gemini Chat

A no-login chat website powered by the Google Gemini API. The frontend is served by a small Node.js backend, which keeps the Gemini API key off the public page and out of Git.

This is an independent Gemini-powered chat, not the official Manus service. It can generate chat responses, drafts, and plans. It does not execute external tasks or provide Manus tools such as real slide, website, or video generation.

## Run locally

Requirements: Node.js 20 or newer and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` to your primary key. Optionally set `GEMINI_API_KEY_BACKUP` and `GEMINI_API_KEY_BACKUP_2` as fallback keys. Do not commit `.env`.
2. Start the server with `npm start`.
3. Open `http://localhost:3000`.

The server also reads `GOOGLE_API_KEY` as an alternative primary environment variable. If a key is rejected or reaches its API quota, the server tries the configured fallback keys in order. `GEMINI_MODEL` can override the default model (`gemini-4-hydrogen`).

## Deploy

Deploy this repository as a Node.js web service, not as static-only GitHub Pages. Set the start command to `npm start` and add `GEMINI_API_KEY`, plus optional `GEMINI_API_KEY_BACKUP` and `GEMINI_API_KEY_BACKUP_2`, in the host's secret/environment-variable settings. The app listens on `PORT` supplied by the host. Never put API keys in `index.html`, `script.js`, a public `.env` file, or a GitHub commit.

## No-login usage and limits

Visitors can chat without signing in. The server limits prompts to 8,000 characters, applies a basic per-IP limit of 12 requests per minute, and stops after 200 chat calls per day by default. Set `GEMINI_DAILY_LIMIT` to change the shared daily cap. These in-memory limits reset when the service restarts and are only lightweight safeguards; for production, add a persistent shared rate limiter, usage monitoring, and spending limits on the Google API project. Gemini usage is subject to the model's availability, quota, and billing settings.

The browser keeps the current Gemini interaction ID in memory for follow-up questions. No site account or chat database is used by this starter.
