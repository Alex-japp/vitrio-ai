const { validateFirebaseToken, getUserFromFirestore, getServiceAccountToken } = require('./auth-helper');

const ALLOWED_ORIGINS = [
  'https://vitrio-ai.vercel.app',
  'https://vitrio-ai-git-main-alex-vitrio.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500'
];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Validar token
  let authUser;
  try {
    authUser = await validateFirebaseToken(req.headers.authorization);
  } catch (e) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  // Verificar se é admin
  const userData = await getUserFromFirestore(authUser.uid);
  if (!userData || userData.isAdmin?.booleanValue !== true) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  }

  const action = req.query.action || req.body?.action;

  // ── Listar todos os usuários ─────────────────────────
  if (action === 'users') {
    try {
      const accessToken = await getServiceAccountToken();
      const res2 = await fetch(
        `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users?pageSize=200`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!res2.ok) throw new Error('Erro ao buscar usuários');
      const data = await res2.json();
      const users = (data.documents || []).map(doc => {
        const f = doc.fields || {};
        const id = doc.name.split('/').pop();
        return {
          uid: id,
          id,
          name: f.name?.stringValue || '',
          email: f.email?.stringValue || '',
          plan: f.plan?.stringValue || 'teste',
          credits: parseInt(f.credits?.integerValue || '0'),
          totalCredits: parseInt(f.totalCredits?.integerValue || '0'),
          active: f.active?.booleanValue !== false,
          isAdmin: f.isAdmin?.booleanValue === true,
          whatsapp: f.whatsapp?.stringValue || '',
          onboardingDone: f.onboardingDone?.booleanValue === true,
          customPromptsApproved: f.customPromptsApproved?.booleanValue === true,
          createdAt: f.createdAt?.timestampValue || null,
        };
      });
      return res.status(200).json({ users });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Atualizar usuário ────────────────────────────────
  if (action === 'updateUser' && req.method === 'POST') {
    const { userId, updates } = req.body;
    if (!userId || !updates) return res.status(400).json({ error: 'Dados incompletos' });
    try {
      const accessToken = await getServiceAccountToken();
      const fields = {};
      if (updates.credits !== undefined) fields.credits = { integerValue: updates.credits.toString() };
      if (updates.plan !== undefined) fields.plan = { stringValue: updates.plan };
      if (updates.active !== undefined) fields.active = { booleanValue: updates.active };
      if (updates.customPromptsApproved !== undefined) fields.customPromptsApproved = { booleanValue: updates.customPromptsApproved };

      const updateRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify({ fields })
        }
      );
      if (!updateRes.ok) throw new Error('Erro ao atualizar usuário');
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Ação inválida' });
}
