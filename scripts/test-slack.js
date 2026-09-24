// Sends a sample ping so you can check the Slack webhook works:
//   npm run test-slack   (reads SLACK_WEBHOOK_URL from .env; `vercel env pull .env` fetches it)
const slack = require('../src/slack');

const now = Date.now();
const app = {
  appid: 440,
  name: 'Example Game (test ping)',
  developers: ['Example Studio'],
  publishers: ['Example Studio'],
  followers: 212,
  appearedAt: now - 3 * 24 * 3600 * 1000,
  releaseDate: 'Coming soon',
  headerImage: null,
};
const hit = { gain: 187, from: { at: now - 2 * 24 * 3600 * 1000, followers: 25 }, to: { at: now, followers: 212 } };

slack
  .post(slack.buildMessage(app, hit, now))
  .then(() => console.log('Test ping sent.'))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
