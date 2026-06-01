// ── Validação do Firebase ID Token via Google API ────────
// Usado por todos os endpoints que precisam de autenticação

async function validateFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Token não fornecido');
  }

  const token = authHeader.replace('Bearer ', '').trim();

  // Valida o token com a API do Google
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    }
  );

  if (!res.ok) {
    throw new Error('Token inválido');
  }

  const data = await res.json();
  const user = data.users?.[0];

  if (!user) throw new Error('Usuário não encontrado');
  if (user.disabled) throw new Error('Conta desativada');

  return {
    uid: user.localId,
    email: user.email,
  };
}

// ── Busca dados do usuário no Firestore ──────────────────
async function getUserFromFirestore(uid) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.fields || null;
}

module.exports = { validateFirebaseToken, getUserFromFirestore };
