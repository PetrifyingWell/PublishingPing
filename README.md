# Publishing Ping

Watches every new Steam store page for its first 14 days and posts to a Slack channel when a page meets all three criteria:

1. **Follower spike.** It gains at least **150 followers within any 5-day window** during its first 14 days.
2. **Self-published.** Its developer name(s) match its publisher name(s). Case, punctuation and company suffixes like "LLC" or "Ltd" are ignored.
3. **No demo released.** A demo that is listed but still "coming soon" doesn't count as released.

Each page is pinged at most once. It runs on Vercel: a cron job calls `/api/cron` every hour, and the data lives in Redis. The dashboard at `/` shows what's being tracked.

## Setup (about 10 minutes)

1. **Slack:** go to https://api.slack.com/apps, choose **Create New App**, then **From scratch**. Open **Incoming Webhooks**, turn them on, click **Add New Webhook to Workspace**, and pick the channel. Copy the webhook URL.
2. **Steam:** get a free Web API key at https://steamcommunity.com/dev/apikey.
3. **Vercel:** import this repo as a project. Then:
   - **Storage** tab: connect a Redis database. This adds `REDIS_URL`.
   - **Settings, then Environment Variables:** add `STEAM_API_KEY`, `SLACK_WEBHOOK_URL`, and `CRON_SECRET` (any long random string).
   - Redeploy.

That's it. The first cron run records Steam's current catalog as a baseline. From the next run on, every page that appears gets tracked.

To check the Slack side straight away, run `vercel env pull .env`, `npm install` and `npm run test-slack`. This posts a sample ping.

To trigger a run by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron
```

### Follower counts via GitHub Actions (required)

Steam's community site, where follower counts live, rate-limits Vercel's servers (HTTP 429) but answers GitHub's. So follower counts are read by a GitHub Actions workflow (`.github/workflows/followers.yml`). Every hour at :30 it asks the app which pages are due, reads their follower counts from Steam, and posts them back to `/api/followers`. Everything else, including the criteria and the Slack pings, still happens on Vercel.

To turn it on, go to the repo's **Settings**, then **Secrets and variables**, then **Actions**, and add:

- a **variable** `APP_URL`: your app's address, e.g. `https://your-app.vercel.app` (no trailing slash)
- a **secret** `CRON_SECRET`: the same value as in Vercel

To test it straight away, open the **Actions** tab, pick **Steam follower counts**, and click **Run workflow**. The log lists each page's follower count.

While the workflow is reporting, the Vercel run doesn't read follower counts itself. If the workflow stops reporting for 2 hours, Vercel goes back to trying.

### Vercel plan and schedule

`vercel.json` runs the cron **hourly**, which needs Vercel **Pro**. The **Hobby** plan only allows one cron run a day. On Hobby, pick one of these:

- Change the schedule in `vercel.json` to once a day (for example `"0 9 * * *"`).
- Keep Vercel Cron daily and use the included GitHub Actions workflow (`.github/workflows/cron.yml`) for hourly runs. In the repo's **Settings**, under **Secrets and variables**, then **Actions**, add a variable `CRON_URL` (`https://<your-app>.vercel.app/api/cron`) and a secret `CRON_SECRET`.

To check every 12 hours instead, use `"0 */12 * * *"`. The 5-day window works with any of these schedules.

## How a run works

Each run has a time budget (4 minutes by default, within Vercel's 5-minute limit). Any backlog carries over to the next run.

1. **Find new pages.** It compares Steam's full app list (`IStoreService/GetAppList`) with every appid seen before. Any appid not seen before is a new store page.
2. **Read followers** for tracked pages that match criteria 2 and 3. The count comes from the page's community group (`steamcommunity.com/games/<appid>/memberslistxml`), and each reading is stored. The GitHub workflow does this part at :30 each hour (see above); Vercel only does it if the workflow isn't reporting.
3. **Classify new pages** via `appdetails`. It keeps games only (DLC, software and, by default, NSFW pages are skipped) and records developer, publisher and demo status.
4. **Re-check pages that didn't match** every 3 days, in case they drop a publisher.
5. **Ping.** When a page's readings show a 150-follower gain within 5 days, the app re-reads its developer, publisher and demo right away. It posts to Slack only if the page still matches.

A page's appearance counts as 0 followers. So a page already on 170 followers at its first reading still qualifies. If an appid shows up before its store page is public, the page counts as appearing when it goes public.

Only pages that match criteria 2 and 3 get their followers read. This keeps each run well within Steam's rate limits.

## Endpoints

| Path | What |
| --- | --- |
| `/` | Dashboard: tracked pages, followers, 5-day gain, ping status |
| `/api/tracked` | The same data as JSON |
| `/api/cron` | Runs the tracker (needs `Authorization: Bearer $CRON_SECRET`) |
| `/api/followers` | GET: pages due a follower reading. POST: follower counts read elsewhere (both need `Authorization: Bearer $CRON_SECRET`) |

## Tuning

Thresholds, windows and intervals can all be set with environment variables. See `.env.example`.

## Development

```bash
npm install
npm test           # criteria logic + end-to-end runs against stubbed Steam/Slack and in-memory Redis
npm run run-once   # one real run against the Redis/Steam/Slack in .env
```
