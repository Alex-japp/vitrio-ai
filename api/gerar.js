export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'API Key não configurada.' });

  const { type, prompt, imageBase64 } = req.body;

  if (type !== 'generate') return res.status(400).json({ error: 'Tipo inválido.' });

  try {
    const fullPrompt = `Observe atentamente a joia na imagem fornecida. Reproduza EXATAMENTE este produto na foto gerada — mesmo design, mesmas pedras, mesma cor, mesmos detalhes, mesmo formato. Não invente outro produto. Agora aplique este estilo: ${prompt}`;

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
                text: fullPrompt
              }
            ]
          }
        ],
        tools: [{ type: 'image_generation' }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const imageOutput = data.output?.find(o => o.type === 'image_generation_call');
    if (!imageOutput) throw new Error('Imagem não gerada.');

    return res.status(200).json({ b64_json: imageOutput.result });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
