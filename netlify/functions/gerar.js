exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido.' }) };
  }

  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API Key não configurada no servidor.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Requisição inválida.' }) };
  }

  const { type } = body;

  try {
    if (type === 'analyze') {
      const { imageBase64, imageMime } = body;

      if (!imageBase64 || !imageMime) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Imagem não fornecida.' }) };
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:${imageMime};base64,${imageBase64}` }
              },
              {
                type: 'text',
                text: 'Describe this semi-jewelry product for professional product photography. Include: type, color, material, finish, design and key visual characteristics. Max 2 sentences. Answer in English.'
              }
            ]
          }]
        })
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ description: data.choices[0].message.content })
      };
    }

    if (type === 'generate') {
      const { prompt } = body;

      if (!prompt || typeof prompt !== 'string' || prompt.length < 10) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Prompt inválido.' }) };
      }

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
          quality: 'standard'
        })
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ b64_json: data.data[0].b64_json })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Tipo de requisição inválido.' })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Erro interno do servidor.' })
    };
  }
};
