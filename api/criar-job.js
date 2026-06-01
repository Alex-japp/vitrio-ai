const { Inngest } = require('inngest');
const { validateFirebaseToken, getUserFromFirestore } = require('./auth-helper');

const inngest = new Inngest({
  id: 'vitrio-ai',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // ── Validar Firebase ID Token ─────────────────────────
  let authUser;
  try {
    authUser = await validateFirebaseToken(req.headers.authorization);
  } catch (e) {
    return res.status(401).json({ error: 'Não autorizado: ' + e.message });
  }

  // UID vem do token — ignora qualquer userId do body
  const uid = authUser.uid;

  // ── Buscar dados do usuário no Firestore ─────────────
  const userData = await getUserFromFirestore(uid);
  if (!userData) {
    return res.status(403).json({ error: 'Usuário não encontrado' });
  }

  // ── Verificar conta ativa ────────────────────────────
  const isActive = userData.active?.booleanValue;
  if (isActive === false) {
    return res.status(403).json({ error: 'Conta inativa. Entre em contato com o suporte.' });
  }

  // ── Verificar créditos (admin é isento) ──────────────
  const isAdmin = userData.isAdmin?.booleanValue === true;
  const { imageBase64, prompts, selectedPhotos, code } = req.body;

  if (!imageBase64 || !prompts || !selectedPhotos) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  if (!isAdmin) {
    const credits = parseInt(userData.credits?.integerValue || '0');
    const photosRequested = Array.isArray(selectedPhotos) ? selectedPhotos.length : 1;

    if (credits < photosRequested) {
      return res.status(403).json({
        error: 'Créditos insuficientes',
        credits,
        required: photosRequested
      });
    }
  }

  // ── Validar tamanho da imagem ────────────────────────
  if (imageBase64.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Imagem muito grande. Máximo 5MB.' });
  }

  // ── Criar job ────────────────────────────────────────
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const firestoreRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            status: { stringValue: 'pending' },
            userId: { stringValue: uid }, // UID do token, não do body
            code: { stringValue: code || '' },
            createdAt: { integerValue: Date.now().toString() },
            updatedAt: { integerValue: Date.now().toString() }
          }
        })
      }
    );

    if (!firestoreRes.ok) {
      const err = await firestoreRes.text();
      return res.status(500).json({ error: 'Erro Firestore: ' + err });
    }

    await inngest.send({
      name: 'vitrio/gerar',
      data: {
        jobId,
        imageBase64,
        prompts,
        selectedPhotos,
        userId: uid, // UID do token
        code: code || ''
      }
    });

    return res.status(200).json({ jobId });
  } catch (e) {
    console.error('Erro criar-job:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
