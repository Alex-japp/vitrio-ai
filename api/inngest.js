const { Inngest } = require('inngest');
const { serve } = require('inngest/next');

const inngest = new Inngest({
  id: 'vitrio-ai',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

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
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          { type: 'text', text: `Analise esta joia e retorne APENAS JSON:
{"metal":"ouro|prata|rose_gold","acabamento":"polido|fosco","pedras":true,"tipo_pedra":"cristal|zirconia|perola|sem_pedra","quantidade_pedras":0,"perolas":false,"quantidade_perolas":0,"tipo_elo":"retangular|oval|figaro|sem_elo","espessura_elo":"fina|media|grossa","fecho":"lagosta|mola|gaveta|sem_fecho","pingente":false,"tipo_pingente":"sem_pingente","gravacao":false,"detalhes_extras":""}` }
        ]
      }]
    })
  });
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return {}; }
}

function montarDescricao(analise) {
  const p = [];
  if (analise.metal) p.push(`metal: ${analise.metal}`);
  if (analise.acabamento) p.push(`acabamento ${analise.acabamento}`);
  if (analise.pedras && analise.tipo_pedra !== 'sem_pedra') p.push(`${analise.quantidade_pedras} pedra(s) ${analise.tipo_pedra}`);
  if (analise.perolas) p.push(`${analise.quantidade_perolas} pérola(s)`);
  if (analise.tipo_elo !== 'sem_elo') p.push(`elo ${analise.tipo_elo} ${analise.espessura_elo}`);
  if (analise.fecho !== 'sem_fecho') p.push(`fecho ${analise.fecho}`);
  if (analise.pingente && analise.tipo_pingente !== 'sem_pingente') p.push(`pingente ${analise.tipo_pingente}`);
  if (analise.gravacao) p.push('com gravação');
  if (analise.detalhes_extras) p.push(analise.detalhes_extras);
  return p.length > 0 ? `\nCaracterísticas: ${p.join(', ')}.` : '';
}

async function gerarFoto(prompt, imageBase64, descricao = '', retries = 3) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: [{
        role: 'user',
        content: [
          { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` },
          { type: 'input_text', text: `Reproduza EXATAMENTE este produto. Aplique: ${prompt + descricao}` }
        ]
      }],
      tools: [{ type: 'image_generation', size: '1024x1024' }]
    })
  });
  if (response.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, 15000));
    return gerarFoto(prompt, imageBase64, descricao, retries - 1);
  }
  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  const data = await response.json();
  const img = data.output?.find(o => o.type === 'image_generation_call');
  if (!img) throw new Error('Imagem não gerada');
  return img.result;
}

async function updateJob(jobId, updates) {
  const fields = {};
  Object.entries(updates).forEach(([k, v]) => {
    if (k === 'status') fields[k] = { stringValue: v };
    else if (k === 'updatedAt') fields[k] = { integerValue: v.toString() };
    else fields[`photo_${k}`] = { stringValue: v };
  });
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    }
  );
}

const gerarFotos = inngest.createFunction(
  { id: 'gerar-fotos', retries: 2, timeouts: { finish: '10m' } },
  { event: 'vitrio/gerar' },
  async ({ event, step }) => {
    const { jobId, imageBase64, prompts, selectedPhotos } = event.data;
    await updateJob(jobId, { status: 'processing', updatedAt: Date.now() });

    const analise = await step.run('analisar', async () => {
      try { return await analisarPeca(imageBase64); } catch { return {}; }
    });
    const descricao = montarDescricao(analise);

    let photo1 = null;
    if (selectedPhotos.includes(1)) {
      photo1 = await step.run('foto-1', async () => {
        const b64 = await gerarFoto(prompts[1], imageBase64, descricao);
        await updateJob(jobId, { 1: b64, updatedAt: Date.now() });
        return b64;
      });
    }

    const ref = photo1 || imageBase64;
    if (selectedPhotos.includes(2)) {
      await step.run('foto-2', async () => {
        const b64 = await gerarFoto(prompts[2], ref, descricao);
        await updateJob(jobId, { 2: b64, updatedAt: Date.now() });
      });
    }
    if (selectedPhotos.includes(3)) {
      await step.run('foto-3', async () => {
        const b64 = await gerarFoto(prompts[3], ref, descricao);
        await updateJob(jobId, { 3: b64, updatedAt: Date.now() });
      });
    }

    await updateJob(jobId, { status: 'completed', updatedAt: Date.now() });
  }
);

module.exports = serve({
  client: inngest,
  functions: [gerarFotos],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
