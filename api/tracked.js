// JSON version of the dashboard.
const { trackedRows } = require('../src/dashboard');

module.exports = async (req, res) => {
  try {
    res.status(200).json(await trackedRows());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
