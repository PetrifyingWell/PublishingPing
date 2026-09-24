const config = require('./config');
const tracker = require('./tracker');
const { createServer } = require('./web');

if (!config.steamApiKey) {
  console.error('STEAM_API_KEY is not set. Get a free key at https://steamcommunity.com/dev/apikey and add it to .env.');
  process.exit(1);
}

tracker.start();
createServer().listen(config.port, () => {
  console.log(`Publishing Ping running. Dashboard at http://localhost:${config.port}`);
});
