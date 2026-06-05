const { validateFirebaseToken, getServiceAccountToken } = require('./auth-helper');

const ALLOWED_ORIGINS = [
  'https://vitrio-ai.vercel.app',
  'https://vitrio-ai-git-main-alex-vitrio.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500'
];

module.exports = async function handler(req, res) {
  // ── CORS ─────────────────────────────────────────────
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  // ── Validar Firebase ID Token ─────────────────────────
  let authUser;
  try {
    authUser = await validateFirebaseToken(req.headers.authorization);
  } catch (e) {
    return res.status(401).json({ error: 'Não autorizado: ' + e.message });
  }

  const uid = authUser.uid;
  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório' });

  try {
    // ── Lê job com Service Account (bypassa regras do Firestore) ──
    const accessToken = await getServiceAccountToken();
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    );

    if (!response.ok) return res.status(404).json({ error: 'Job não encontrado' });

    const data = await response.json();
    const fields = data.fields || {};

    // ── Verifica se job pertence ao usuário ──────────────
    const jobUserId = fields.userId?.stringValue || '';
    if (jobUserId !== uid) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const result = {
      jobId,
      status: fields.status?.stringValue || 'pending',
      photos: {}
    };

    [1, 2, 3, 4, 5, 6].forEach(n => {
      if (fields[`photo_${n}`]?.stringValue) {
        result.photos[n] = fields[`photo_${n}`].stringValue;
      }
    });

    return res.status(200).json(result);
  } catch (e) {
    console.error('Erro status:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
