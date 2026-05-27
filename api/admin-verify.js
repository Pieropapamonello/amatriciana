module.exports = (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminPass = process.env.ADMIN_PASS || '';
  if (!adminPass) {
    return res.status(503).json({ ok: false, error: 'Password admin non configurata' });
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Password mancante' });
  }

  const timingSafeEqual = require('crypto').timingSafeEqual;
  const a = Buffer.from(password.normalize('NFC'));
  const b = Buffer.from(adminPass.normalize('NFC'));
  const ok = a.length === b.length && timingSafeEqual(a, b);

  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok });
};
