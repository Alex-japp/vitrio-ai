export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'API Key não configurada.' });

  const { type, prompt, imageBase64, appPass } = req.body;

  if (type === 'auth') {
    const validPass = appPass === process.env.APP_PASS;
    const isAdmin = appPass === process.env.ADMIN_PASS;
    if (!validPass && !isAdmin) return res.status(401).json({ error: 'Senha incorreta.' });
    return res.status(200).json({ ok: true, admin: isAdmin });
  }

  if (type !== 'generate') return res.status(400).json({ error: 'Tipo inválido.' });

  async function callOpenAI(retries = 3, delay = 10000) {
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
                text: `Observe atentamente a joia na imagem. Reproduza EXATAMENTE este produto — mesmo design, mesmas pedras, mesma cor, mesmos detalhes, mesmo formato. Não invente outro produto. Aplique este estilo: ${prompt}`
              }
            ]
          }
        ],
        tools: [{ type: 'image_generation', size: '1024x1024' }]
      })
    });

    if (response.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, delay));
      return callOpenAI(retries - 1, delay + 10000);
    }

    return response;
  }

  try {
    const response = await callOpenAI();
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const imageOutput = data.output?.find(o => o.type === 'image_generation_call');
    if (!imageOutput) throw new Error('Imagem não gerada.');
    return res.status(200).json({ b64_json: imageOutput.result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
