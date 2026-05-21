export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'API Key não configurada.' });

  const { type, prompt, imageBase64, obs } = req.body;

  if (type !== 'generate') return res.status(400).json({ error: 'Tipo inválido.' });

  try {
    // PASSO 1: GPT-4o analisa a foto e descreve o produto detalhadamente
    const visionRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageBase64}` }
            },
            {
              type: 'text',
              text: 'Descreva este produto de semijoias com todos os detalhes visuais: formato, cor, material, pedras, acabamento, detalhes únicos. Seja muito específico e detalhado. Responda apenas com a descrição, sem introdução.'
            }
          ]
        }]
      })
    });

    const visionData = await visionRes.json();
    if (visionData.error) throw new Error(visionData.error.message);
    const description = visionData.choices[0].message.content;

    // PASSO 2: gpt-image-1 gera a foto profissional usando a descrição
    const fullPrompt = `${prompt}\n\nProduto: ${description}${obs ? '\nObservações: ' + obs : ''}`;

    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const blob = new Blob([imageBuffer], { type: 'image/png' });

    const formData = new FormData();
    formData.append('model', 'gpt-image-1');
    formData.append('prompt', fullPrompt);
    formData.append('image', blob, 'produto.png');
    formData.append('size', '1024x1024');

    const imageRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData
    });

    const imageData = await imageRes.json();
    if (imageData.error) throw new Error(imageData.error.message);

    return res.status(200).json({ b64_json: imageData.data[0].b64_json });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
