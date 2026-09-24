# Publishing Ping

Watches every new Steam store page for its first 14 days and posts to Slack the moment a page meets all three criteria:

1. **Follower spike.** It gains at least **150 followers within any 5-day window** during its first 14 days.
2. **Self-published.** Its developer name(s) match its publisher name(s). Case, punctuation and company suffixes like "LLC" or "Ltd" are ignored.
3. **No demo released.** A demo that is listed but still "coming soon" doesn't count as released.

Each page is pinged at most once.

## How it works

It runs as one long-lived Node process (a worker plus a small dashboard):

| Job | Every | What it does |
| --- | --- | --- |
| App-list sync | 20 min | Diffs Steam's full app list (`IStoreService/GetAppList`) against every appid seen before. New appids are new store pages. |
| Classify | 30 s | Looks up new pages via `appdetails` and keeps games (DLC, software and, by default, NSFW pages are skipped). It records developer, publisher and demo status, and refreshes them every 12 h. |
| Followers | continuous | Reads each page's follower count from its community group (`steamcommunity.com/games/<appid>/memberslistxml`) and stores a snapshot. |

How often a page's followers are checked depends on how close it is to qualifying:

- Pages that meet criteria 2 and 3: every 60 min, every 15 min once they're halfway to 150, and every 5 min in the last 20%.
- Every other page: every 6 h. This keeps its history, so if the page later changes (for example, the publisher is changed to the studio itself), it can still qualify.

Just before pinging, the app fetches the page's developer, publisher and demo status again, so it never pings about a page that has just signed a publisher or released a demo.

A page's appearance counts as 0 followers. So a page that already has 170 followers the first time it's polled, a few minutes after it appeared, still qualifies. If a page's appid is in the list before its store page goes public, it counts as appearing when it goes public.

**First run:** there's nothing to diff against yet, so the first sync records the current catalog as the baseline. Tracking starts with the pages that appear after that.

## Setup

```bash
cp .env.example .env   # fill in STEAM_API_KEY and SLACK_WEBHOOK_URL
npm install
npm run test-slack     # sends a sample ping to check the webhook
npm start              # dashboard at http://localhost:3000
```

- **Steam API key:** free from https://steamcommunity.com/dev/apikey.
- **Slack webhook:** create a Slack app, turn on *Incoming Webhooks*, and add a webhook for the channel that should get the pings.

## Deploying

This needs an always-on host with a persistent disk, because the follower history is stored in SQLite under `DATA_DIR`. Serverless platforms like Vercel won't work. Any of these do:

- **Docker:** `docker build -t publishing-ping . && docker run -d --env-file .env -v pp-data:/data -p 3000:3000 publishing-ping`
- **Railway / Render / Fly.io:** deploy from the Dockerfile, attach a volume at `/data`, and set the env vars.
- **A VPS:** `npm start` under pm2 or systemd.

`GET /healthz` returns the last sync time and counts for uptime checks. `GET /api/tracked` returns the dashboard data as JSON.

## Tuning

All thresholds, windows and polling intervals can be set with environment variables. See `.env.example`.

## Tests

```bash
npm test
```

These cover the criteria logic and an end-to-end run against stubbed Steam and Slack.
