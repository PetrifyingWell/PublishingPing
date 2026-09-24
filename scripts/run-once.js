// Runs one cron pass locally against the Redis in REDIS_URL:
//   npm run run-once   (`vercel env pull .env` fetches the project's env vars)
const tracker = require('../src/tracker');
const store = require('../src/store');

tracker
  .run()
  .then((result) => console.log(JSON.stringify({ ...result, log: undefined }, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => store.redis().quit());
