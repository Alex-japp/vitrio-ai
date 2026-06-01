const { Inngest } = require('inngest');
const { validateFirebaseToken, getUserFromFirestore, getServiceAccountToken } = require('./auth-helper');

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

const RATE_LIMIT = 20;        // máximo de requisições
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora em ms

// ── Rate limiting via Firestore ──────────────────────────
async function checkRateLimit(uid, accessToken) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const docUrl = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ratelimit/${uid}`;

  // Lê o documento atual
  const getRes = await fetch(docUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  let requests = [];
  if (getRes.ok) {
    const data = await getRes.json();
    const raw = data.fields?.requests?.arrayValue?.values || [];
    // Filtra só as requisições dentro da janela de 1 hora
    requests = raw
      .map(v => parseInt(v.integerValue || '0'))
      .filter(ts => ts > windowStart);
  }

  // Verifica limite
  if (requests.length >= RATE_LIMIT) {
    const oldest = Math.min(...requests);
    const resetIn = Math.ceil((oldest + RATE_WINDOW_MS - now) / 60000);
    return { allowed: false, resetIn, count: requests.length };
  }

  // Adiciona timestamp atual
  requests.push(now);

  // Salva de volta no Firestore
  await fetch(docUrl, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      fields: {
        requests: {
          arrayValue: {
            values: requests.map(ts => ({ integerValue: ts.toString() }))
          }
        },
        updatedAt: { integerValue: now.toString() }
      }
    })
  });

  return { allowed: true, count: requests.length };
}

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

  const isAdmin = userData.isAdmin?.booleanValue === true;
  const { imageBase64, prompts, selectedPhotos, code } = req.body;

  if (!imageBase64 || !prompts || !selectedPhotos) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  // ── Verificar créditos (admin é isento) ──────────────
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

  // ── Rate limiting (admin é isento) ───────────────────
  if (!isAdmin) {
    try {
      const accessToken = await getServiceAccountToken();
      const rateCheck = await checkRateLimit(uid, accessToken);
      if (!rateCheck.allowed) {
        return res.status(429).json({
          error: `Limite de ${RATE_LIMIT} gerações por hora atingido. Tente novamente em ${rateCheck.resetIn} minuto(s).`
        });
      }
    } catch (e) {
      console.error('Erro rate limit:', e.message);
      // Se o rate limit falhar, deixa passar — não bloqueia o usuário
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
            userId: { stringValue: uid },
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
        userId: uid,
        code: code || ''
      }
    });

    return res.status(200).json({ jobId });
  } catch (e) {
    console.error('Erro criar-job:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
