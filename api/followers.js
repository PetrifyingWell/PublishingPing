// Follower counts are read outside Vercel, because steamcommunity.com
// rate-limits Vercel's servers. The GitHub Actions workflow in
// .github/workflows/followers.yml calls this hourly:
//   GET  /api/followers  -> { appids: [...] }  pages due a follower reading
//   POST /api/followers  { results: [{ appid, followers } | { appid, error }] }
// Both need "Authorization: Bearer <CRON_SECRET>".
const config = require('../src/config');
const tracker = require('../src/tracker');

module.exports = async (req, res) => {
  if (!config.cronSecret || req.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (req.method === 'GET') return res.status(200).json({ appids: await tracker.dueFollowerChecks() });
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      return res.status(200).json(await tracker.recordExternalFollowers(body.results));
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Follower endpoint failed:', err);
    return res.status(500).json({ error: err.message });
  }
};
