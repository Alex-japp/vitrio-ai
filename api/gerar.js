export const config = {
  maxDuration: 300
};

// ── ETAPA 1: ANÁLISE TÉCNICA DA PEÇA ────────────────────
async function analisarPeca(imageBase64) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
            },
            {
              type: 'text',
              text: `Analise esta imagem de uma joia/semijoia e retorne APENAS um JSON técnico com as características da peça. Não crie prompts. Não descreva estilos. Apenas identifique as características reais visíveis.

Retorne SOMENTE o JSON, sem explicações:
{
  "metal": "ouro|prata|rose_gold|desconhecido",
  "acabamento": "polido|fosco|escovado|texturizado",
  "pedras": true|false,
  "tipo_pedra": "cristal|zirconia|rubi|esmeralda|pérola|sem_pedra",
  "quantidade_pedras": numero ou 0,
  "perolas": true|false,
  "quantidade_perolas": numero ou 0,
  "tipo_elo": "retangular|oval|redondo|figaro|veneziana|cartier|grumette|sem_elo",
  "espessura_elo": "fina|media|grossa",
  "fecho": "lagosta|mola|gaveta|toggle|sem_fecho|nao_visivel",
  "pingente": true|false,
  "tipo_pingente": "coracao|cruz|letra|simbolo|sem_pingente",
  "gravacao": true|false,
  "detalhes_extras": "descreva em ate 15 palavras detalhes unicos e importantes da peca"
}`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Analise falhou: ${JSON.stringify(err)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    return {};
  }
}

// ── MONTA DESCRIÇÃO TÉCNICA A PARTIR DO JSON ─────────────
function montarDescricaoTecnica(analise) {
  const partes = [];

  if (analise.metal && analise.metal !== 'desconhecido') {
    partes.push(`metal: ${analise.metal}`);
  }
  if (analise.acabamento) {
    partes.push(`acabamento ${analise.acabamento}`);
  }
  if (analise.pedras && analise.tipo_pedra && analise.tipo_pedra !== 'sem_pedra') {
    const qtd = analise.quantidade_pedras > 0 ? `${analise.quantidade_pedras} ` : '';
    partes.push(`${qtd}pedra(s) ${analise.tipo_pedra}`);
  }
  if (analise.perolas && analise.quantidade_perolas > 0) {
    partes.push(`${analise.quantidade_perolas} pérola(s)`);
  }
  if (analise.tipo_elo && analise.tipo_elo !== 'sem_elo') {
    const espessura = analise.espessura_elo ? ` ${analise.espessura_elo}` : '';
    partes.push(`elo ${analise.tipo_elo}${espessura}`);
  }
  if (analise.fecho && analise.fecho !== 'sem_fecho' && analise.fecho !== 'nao_visivel') {
    partes.push(`fecho ${analise.fecho}`);
  }
  if (analise.pingente && analise.tipo_pingente && analise.tipo_pingente !== 'sem_pingente') {
    partes.push(`pingente ${analise.tipo_pingente}`);
  }
  if (analise.gravacao) {
    partes.push('com gravação');
  }
  if (analise.detalhes_extras) {
    partes.push(analise.detalhes_extras);
  }

  return partes.length > 0
    ? `\nCaracterísticas técnicas da peça: ${partes.join(', ')}.`
    : '';
}

// ── ETAPA 2: GERAÇÃO COM OPENAI ──────────────────────────
async function gerarOpenAI(prompt, imageBase64, descricaoTecnica = '', retries = 3, delay = 10000) {
  const promptFinal = prompt + descricaoTecnica;

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
              text: `Observe atentamente a joia na imagem. Reproduza EXATAMENTE este produto — mesmo design, mesmas pedras, mesma cor, mesmos detalhes, mesmo formato. Nao invente outro produto. Aplique este estilo: ${promptFinal}`
            }
          ]
        }
      ],
      tools: [{ type: 'image_generation', size: '1024x1024' }]
    })
  });

  if (response.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, delay));
    return gerarOpenAI(prompt, imageBase64, descricaoTecnica, retries - 1, delay + 10000);
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

// ── FALLBACK: FLUX Redux Dev via Replicate ───────────────
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

  if (prediction.output && prediction.output[0]) {
    return await urlToBase64(prediction.output[0]);
  }

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

// ── HANDLER PRINCIPAL ────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'API Key nao configurada.' });

  const { type, prompt, imageBase64, imageBase64Ref, email } = req.body;

  // Verificação admin
  if (type === 'checkAdmin') {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    const isAdmin = adminEmails.includes((email || '').toLowerCase());
    return res.status(200).json({ isAdmin });
  }

  // Análise técnica da peça (nova etapa)
  if (type === 'analyze') {
    try {
      const analise = await analisarPeca(imageBase64);
      return res.status(200).json({ analise });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (type !== 'generate') return res.status(400).json({ error: 'Tipo invalido.' });

  // imageBase64Ref = foto de referência (foto1 gerada para fotos 2 e 3)
  // imageBase64 = foto original do cliente (para análise técnica)
  const imagemParaGerar = imageBase64Ref || imageBase64;
  const imagemParaAnalise = imageBase64; // sempre a foto original

  // Monta descrição técnica a partir da análise (se disponível no body)
  let descricaoTecnica = '';
  if (req.body.analise) {
    descricaoTecnica = montarDescricaoTecnica(req.body.analise);
  }

  // Geração com OpenAI + FLUX fallback
  try {
    const b64 = await gerarOpenAI(prompt, imagemParaGerar, descricaoTecnica);
    return res.status(200).json({ b64_json: b64, source: 'openai' });
  } catch (openaiError) {
    console.warn('OpenAI falhou, tentando FLUX Redux:', openaiError.message);
    try {
      const b64 = await gerarFLUX(prompt, imagemParaGerar);
      return res.status(200).json({ b64_json: b64, source: 'flux' });
    } catch (fluxError) {
      console.error('FLUX tambem falhou:', fluxError.message);
      return res.status(500).json({
        error: 'Nossos servidores estao sobrecarregados no momento. Aguarde alguns minutos e tente novamente.'
      });
    }
  }
}
