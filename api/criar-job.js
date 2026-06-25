const { Inngest } = require('inngest');
const { validateFirebaseToken, getUserFromFirestore, getServiceAccountToken } = require('./auth-helper');

const inngest = new Inngest({
  id: 'vitrio-ai',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

const ALLOWED_ORIGINS = [
  'https://vitrioai.com.br',
  'https://vitrio-ai.vercel.app',
  'https://vitrio-ai-git-main-alex-vitrio.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500'
];

const RATE_LIMIT     = 100;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// ── Rate limiting via Firestore ──────────────────────────
async function checkRateLimit(uid, accessToken) {
  const now         = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const docUrl      = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ratelimit/${uid}`;

  const getRes = await fetch(docUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  let requests = [];
  if (getRes.ok) {
    const data = await getRes.json();
    const raw  = data.fields?.requests?.arrayValue?.values || [];
    requests   = raw
      .map(v => parseInt(v.integerValue || '0'))
      .filter(ts => ts > windowStart);
  }

  if (requests.length >= RATE_LIMIT) {
    const oldest  = Math.min(...requests);
    const resetIn = Math.ceil((oldest + RATE_WINDOW_MS - now) / 60000);
    return { allowed: false, resetIn, count: requests.length };
  }

  requests.push(now);

  await fetch(docUrl, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
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

// ── Upload para Firebase Storage via REST ────────────────
async function uploadToStorage(accessToken, filePath, base64Data, contentType = 'image/jpeg') {
  const bucket   = `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`;
  const encoded  = encodeURIComponent(filePath);
  const url      = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encoded}`;

  const buffer   = Buffer.from(base64Data, 'base64');

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  contentType,
    },
    body: buffer
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Storage upload falhou: ${err}`);
  }

  // Retorna URL pública autenticada (signed) via download token
  const encodedPath = encodeURIComponent(filePath);
  const publicUrl   = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;
  return publicUrl;
}

// ── Handler principal ────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método não permitido' });

  // Validar token
  let authUser;
  try {
    authUser = await validateFirebaseToken(req.headers.authorization);
  } catch (e) {
    return res.status(401).json({ error: 'Não autorizado: ' + e.message });
  }

  const uid = authUser.uid;

  // Buscar usuário
  const userData = await getUserFromFirestore(uid);
  if (!userData) return res.status(403).json({ error: 'Usuário não encontrado' });

  if (userData.active?.booleanValue === false) {
    return res.status(403).json({ error: 'Conta inativa. Entre em contato com o suporte.' });
  }

  const isAdmin = userData.isAdmin?.booleanValue === true;
  const { imageBase64, prompts, selectedPhotos, code, category, metalColor } = req.body;

  if (!imageBase64 || !prompts || !selectedPhotos) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  // Validar tamanho (5MB base64)
  if (imageBase64.length > 7 * 1024 * 1024) {
    return res.status(400).json({ error: 'Imagem muito grande. Máximo 5MB.' });
  }

  // Verificar créditos
  if (!isAdmin) {
    const credits        = parseInt(userData.credits?.integerValue || '0');
    const photosRequired = Array.isArray(selectedPhotos) ? selectedPhotos.length : 1;
    if (credits < photosRequired) {
      return res.status(403).json({ error: 'Créditos insuficientes', credits, required: photosRequired });
    }
  }

  // Service account token (usado para Storage + Firestore + Rate limit)
  let accessToken;
  try {
    accessToken = await getServiceAccountToken();
  } catch (e) {
    return res.status(500).json({ error: 'Erro de autenticação interna: ' + e.message });
  }

  // Rate limiting
  if (!isAdmin) {
    try {
      const rateCheck = await checkRateLimit(uid, accessToken);
      if (!rateCheck.allowed) {
        return res.status(429).json({
          error: `Limite de ${RATE_LIMIT} gerações por hora atingido. Tente novamente em ${rateCheck.resetIn} minuto(s).`
        });
      }
    } catch (e) {
      console.error('Erro rate limit:', e.message);
      // Se falhar, deixa passar
    }
  }

  // Gerar jobId
  const jobId    = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now      = Date.now();
  const filePath = `jobs/${jobId}/original.jpg`;

  try {
    // 1. Upload da imagem original no Firebase Storage
    const imageOriginalUrl = await uploadToStorage(accessToken, filePath, imageBase64, 'image/jpeg');

    // 2. Salvar job completo no Firestore (sem imageBase64, sem prompts grandes no evento)
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`;

    const firestoreRes = await fetch(firestoreUrl, {
      method:  'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        fields: {
          status:           { stringValue: 'pending' },
          userId:           { stringValue: uid },
          code:             { stringValue: code || '' },
          category:         { stringValue: category || '' },
          imageOriginalUrl: { stringValue: imageOriginalUrl },
          imageFilePath:    { stringValue: filePath },
          selectedPhotos:   {
            arrayValue: {
              values: (Array.isArray(selectedPhotos) ? selectedPhotos : [selectedPhotos])
                .map(n => ({ integerValue: n.toString() }))
            }
          },
          prompts: {
            mapValue: {
              fields: Object.fromEntries(
                Object.entries(prompts).map(([k, v]) => [k, { stringValue: v }])
              )
            }
          },
          metalColor:       { stringValue: metalColor || 'auto' },
          createdAt: { integerValue: now.toString() },
          updatedAt: { integerValue: now.toString() }
        }
      })
    });

    if (!firestoreRes.ok) {
      const err = await firestoreRes.text();
      return res.status(500).json({ error: 'Erro ao criar job: ' + err });
    }

    // 3. Enviar para o Inngest SOMENTE o jobId
    await inngest.send({
      name: 'vitrio/gerar',
      data: { jobId }
    });

    return res.status(200).json({ jobId });

  } catch (e) {
    console.error('Erro criar-job:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
