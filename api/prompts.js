const { validateFirebaseToken } = require('./auth-helper');

const ALLOWED_ORIGINS = [
  'https://vitrioai.com.br',
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

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'API não configurada' });
  }

  const { prompt, maxTokens } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt obrigatório' });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: maxTokens || 1500,
        messages: [
          {
            role: 'system',
            content: 'Você é especialista em fotografia de semijoias para e-commerce brasileiro. Responda sempre em português.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: 'Erro na API' });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Retorna no mesmo formato que a API da Anthropic
    // para não precisar mudar nada no index.html
    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (e) {
    console.error('Erro prompts:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
