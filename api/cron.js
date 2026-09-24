// Called by Vercel Cron (see vercel.json). Vercel sends
// "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set, which also
// lets you trigger a run by hand:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron
const config = require('../src/config');
const tracker = require('../src/tracker');

module.exports = async (req, res) => {
  if (config.cronSecret && req.headers.authorization !== `Bearer ${config.cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    res.status(200).json(await tracker.run());
  } catch (err) {
    console.error('Cron run failed:', err);
    res.status(500).json({ error: err.message });
  }
};
