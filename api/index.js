// The dashboard, served at "/" (see the rewrite in vercel.json).
const { trackedRows, renderPage } = require('../src/dashboard');

module.exports = async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderPage(await trackedRows()));
  } catch (err) {
    res.status(500).send(`<pre>${String(err.message).replace(/</g, '&lt;')}</pre>`);
  }
};
