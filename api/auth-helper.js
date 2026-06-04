// ── Validação do Firebase ID Token via Google API ────────
async function validateFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Token não fornecido');
  }
  const token = authHeader.replace('Bearer ', '').trim();
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    }
  );
  if (!res.ok) throw new Error('Token inválido');
  const data = await res.json();
  const user = data.users?.[0];
  if (!user) throw new Error('Usuário não encontrado');
  if (user.disabled) throw new Error('Conta desativada');
  return { uid: user.localId, email: user.email };
}
// ── Gera Access Token do Service Account ────────────────
async function getServiceAccountToken() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.full_control'
  };
  // Codifica header e payload em base64url
  const encode = (obj) => Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  // Assina com a chave privada usando crypto nativo do Node
  const crypto = require('crypto');
  const privateKey = serviceAccount.private_key;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = `${signingInput}.${signature}`;
  // Troca JWT por access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error('Erro ao obter token do service account: ' + err);
  }
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}
// ── Busca dados do usuário no Firestore (autenticado) ────
async function getUserFromFirestore(uid) {
  const accessToken = await getServiceAccountToken();
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.fields || null;
}
module.exports = { validateFirebaseToken, getUserFromFirestore, getServiceAccountToken };
