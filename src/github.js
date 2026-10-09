// Starts the GitHub Actions follower workflow (.github/workflows/followers.yml)
// from the hourly Vercel cron. GitHub runs scheduled workflows only a few
// times a day, so the schedule alone leaves most pages unchecked; a
// workflow_dispatch call starts it straight away.
const config = require('./config');

function isConfigured() {
  return !!(config.githubDispatchToken && config.githubRepo);
}

async function dispatchFollowerWorkflow() {
  if (!isConfigured()) return 'not set up';
  const url = `https://api.github.com/repos/${config.githubRepo}/actions/workflows/followers.yml/dispatches`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.githubDispatchToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'publishing-ping',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status !== 204) throw new Error(`GitHub responded with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return 'started';
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { isConfigured, dispatchFollowerWorkflow };
