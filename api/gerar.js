export const config = {
  maxDuration: 300
};

// ── FALLBACK: FLUX Redux Dev via Replicate ──────────────
async function urlToBase64(url) {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

async function gerarFLUX(prompt, imageBase64) {
  if (!process.env.REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY nao configurada.');

  const startRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-redux-dev/predictions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}`,
      'Prefer': 'wait'
    },
    body: JSON.stringify({
      input: {
        redux_image: `data:image/jpeg;base64,${imageBase64}`,
        prompt: prompt,
        num_outputs: 1,
        aspect_ratio: '1:1',
        output_format: 'webp',
        output_quality: 90
      }
    })
  });

  if (!startRes.ok) {
    const err = await startRes.json();
    throw new Error(`FLUX erro: ${JSON.stringify(err)}`);
  }

  const prediction = await startRes.json();

  // Retornou direto (Prefer: wait)
  if (prediction.output && prediction.output[0]) {
    return await urlToBase64(prediction.output[0]);
  }

  // Polling
  const pollUrl = prediction.urls?.get;
  if (!pollUrl) throw new Error('FLUX: URL de polling nao encontrada.');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}` }
    });
    const poll = await pollRes.json();
    if (poll.status === 'succeeded' && poll.output?.[0]) {
      return await urlToBase64(poll.output[0]);
    }
    if (poll.status === 'failed') throw new Error('FLUX: geracao falhou.');
  }
  throw new Error('FLUX: timeout no polling.');
}

// ── OPENAI ──────────────────────────────────────────────
async function gerarOpenAI(prompt, imageBase64, retries = 3, delay = 10000) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${imageBase64}`
            },
            {
              type: 'input_text',
              text: `Observe atentamente a joia na imagem. Reproduza EXATAMENTE este produto — mesmo design, mesmas pedras, mesma cor, mesmos detalhes, mesmo formato. Nao invente outro produto. Aplique este estilo: ${prompt}`
            }
          ]
        }
      ],
      tools: [{ type: 'image_generation', size: '1024x1024' }]
    })
  });

  if (response.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, delay));
    return gerarOpenAI(prompt, imageBase64, retries - 1, delay + 10000);
  }

  if (!response.ok) {
    const errData = await response.json();
    throw new Error(`OpenAI ${response.status}: ${JSON.stringify(errData)}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const imageOutput = data.output?.find(o => o.type === 'image_generation_call');
  if (!imageOutput) throw new Error('Imagem nao gerada pela OpenAI.');
  return imageOutput.result;
}

// ── HANDLER PRINCIPAL ───────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'API Key nao configurada.' });

  const { type, prompt, imageBase64, email } = req.body;

  if (type === 'checkAdmin') {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    const isAdmin = adminEmails.includes((email || '').toLowerCase());
    return res.status(200).json({ isAdmin });
  }

  if (type !== 'generate') return res.status(400).json({ error: 'Tipo invalido.' });

  // Tenta OpenAI primeiro, se falhar usa FLUX como fallback
  try {
    const b64 = await gerarOpenAI(prompt, imageBase64);
    return res.status(200).json({ b64_json: b64, source: 'openai' });
  } catch (openaiError) {
    console.warn('OpenAI falhou, tentando FLUX Redux:', openaiError.message);
    try {
      const b64 = await gerarFLUX(prompt, imageBase64);
      return res.status(200).json({ b64_json: b64, source: 'flux' });
    } catch (fluxError) {
      console.error('FLUX tambem falhou:', fluxError.message);
      return res.status(500).json({
        error: 'Nossos servidores estao sobrecarregados no momento. Aguarde alguns minutos e tente novamente.'
      });
    }
  }
}
