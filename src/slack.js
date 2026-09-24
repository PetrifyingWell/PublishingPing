const config = require('./config');

function fmtDuration(ms) {
  const h = ms / config.HOUR;
  if (h < 1) return `${Math.max(1, Math.round(ms / config.MINUTE))} min`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)} days`;
}

function buildMessage(app, hit, now = Date.now()) {
  const url = `https://store.steampowered.com/app/${app.appid}/`;
  const studio = app.developers.join(', ') || 'Unknown';
  const fromLabel = hit.from.implicit ? 'page appeared' : `${hit.from.followers.toLocaleString()} followers`;
  const lines = [
    `*<${url}|${app.name}>* gained *${hit.gain.toLocaleString()} followers* in ${fmtDuration(hit.to.at - hit.from.at)}`,
    `Now at *${app.followers.toLocaleString()}* followers (from ${fromLabel})`,
    `Developer & publisher: *${studio}*  ·  No demo released`,
    `Page appeared ${fmtDuration(now - app.appearedAt)} ago  ·  Release: ${app.releaseDate || 'TBD'}`,
  ];

  const section = { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } };
  if (app.headerImage) section.accessory = { type: 'image', image_url: app.headerImage, alt_text: app.name };

  return {
    text: `${app.name} gained ${hit.gain} followers (self-published, no demo)`,
    blocks: [
      section,
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Steam page' }, url },
          { type: 'button', text: { type: 'plain_text', text: 'SteamDB' }, url: `https://steamdb.info/app/${app.appid}/` },
        ],
      },
    ],
  };
}

async function post(payload) {
  if (!config.slackWebhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set.');
  const res = await fetch(config.slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Slack webhook responded with HTTP ${res.status}: ${await res.text()}`);
}

module.exports = { buildMessage, post };
