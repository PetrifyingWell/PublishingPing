// Sends a sample ping so you can check the Slack webhook works:
//   npm run test-slack
const slack = require('../src/slack');

const now = Date.now();
const app = {
  appid: 440,
  name: 'Example Game (test ping)',
  developers: ['Example Studio'],
  publishers: ['Example Studio'],
  followers: 212,
  appeared_at: now - 3 * 24 * 3600 * 1000,
  release_date: 'Coming soon',
  header_image: null,
};
const hit = { gain: 187, from: { at: now - 2 * 24 * 3600 * 1000, followers: 25 }, to: { at: now, followers: 212 } };

slack
  .post(slack.buildMessage(app, hit, now))
  .then(() => console.log('Test ping sent.'))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
