const { Inngest } = require('inngest');
const { serve } = require('inngest/express');

const inngest = new Inngest({
  id: 'vitrio-ai',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// ── COMPRESSÃO SIMPLES SEM SHARP ─────────────────────────
async function comprimirImagem(b64) {
  // Por enquanto retorna sem compressão — sharp será reativado futuramente
  return b64;
}

// ── SALVA IMAGEM NO FIREBASE STORAGE E RETORNA URL ──────
async function salvarImagem(jobId, photoNum, b64) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const fileName = `jobs/${jobId}/photo_${photoNum}.jpg`;
  // URL correta para projetos novos do Firebase (.firebasestorage.app)
  const bucket = `${projectId}.firebasestorage.app`;
  const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(fileName)}?uploadType=media`;

  // Comprime para 300-500KB antes de salvar
  const b64Comprimido = await comprimirImagem(b64);
  const buffer = Buffer.from(b64Comprimido, 'base64');

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buffer
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Storage upload falhou: ${err}`);
  }

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(fileName)}?alt=media`;
  return url;
}

// ── ATUALIZA CAMPOS ESPECÍFICOS SEM SOBRESCREVER ─────────
async function updateJob(jobId, updates) {
  const fields = {};
  const fieldPaths = [];

  Object.entries(updates).forEach(([k, v]) => {
    const fieldName = (k === 'status' || k === 'updatedAt') ? k : `photo_${k}`;
    fieldPaths.push(fieldName);
    if (k === 'status') fields[fieldName] = { stringValue: v };
    else if (k === 'updatedAt') fields[fieldName] = { integerValue: v.toString() };
    else fields[fieldName] = { stringValue: v };
  });

  const maskParams = fieldPaths.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}?${maskParams}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('updateJob erro:', res.status, err);
  }
}

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
  if (analise.tipo_elo && analise.tipo_elo !== 'sem_elo') p.push(`elo ${analise.tipo_elo} ${analise.espessura_elo}`);
  if (analise.fecho && analise.fecho !== 'sem_fecho') p.push(`fecho ${analise.fecho}`);
  if (analise.pingente && analise.tipo_pingente !== 'sem_pingente') p.push(`pingente ${analise.tipo_pingente}`);
  if (analise.gravacao) p.push('com gravação');
  if (analise.detalhes_extras) p.push(analise.detalhes_extras);
  return p.length > 0 ? `\nCaracterísticas: ${p.join(', ')}.` : '';
}

// ── FALLBACK: FLUX Redux Dev via Replicate ───────────────
async function gerarFLUX(prompt, imageBase64) {
  if (!process.env.REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY não configurada.');

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

  if (!startRes.ok) throw new Error(`FLUX erro: ${startRes.status}`);
  const prediction = await startRes.json();

  if (prediction.output && prediction.output[0]) {
    const res = await fetch(prediction.output[0]);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }

  const pollUrl = prediction.urls?.get;
  if (!pollUrl) throw new Error('FLUX: URL de polling não encontrada.');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}` }
    });
    const poll = await pollRes.json();
    if (poll.status === 'succeeded' && poll.output?.[0]) {
      const res = await fetch(poll.output[0]);
      const buffer = await res.arrayBuffer();
      return Buffer.from(buffer).toString('base64');
    }
    if (poll.status === 'failed') throw new Error('FLUX: geração falhou.');
  }
  throw new Error('FLUX: timeout no polling.');
}

async function gerarFoto(prompt, imageBase64, descricao = '', retries = 3) {
  try {
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

  } catch (openaiError) {
    console.warn('OpenAI falhou, tentando FLUX:', openaiError.message);
    return gerarFLUX(prompt, imageBase64);
  }
}

// ── LIMPEZA AUTOMÁTICA DE JOBS ANTIGOS (24H) ─────────────
async function limparJobsAntigos() {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const bucket = `${projectId}.firebasestorage.app`;
    const vinte4h = Date.now() - (24 * 60 * 60 * 1000);

    // Busca jobs com mais de 24h no Firestore
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'jobs' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'createdAt' },
                op: 'LESS_THAN',
                value: { integerValue: vinte4h.toString() }
              }
            },
            limit: 50
          }
        })
      }
    );

    const data = await res.json();
    if (!Array.isArray(data)) return;

    for (const item of data) {
      if (!item.document) continue;
      const jobId = item.document.name.split('/').pop();
      const fields = item.document.fields || {};

      // Deleta fotos do Storage
      for (let n = 1; n <= 3; n++) {
        if (fields[`photo_${n}`]?.stringValue) {
          const fileName = encodeURIComponent(`jobs/${jobId}/photo_${n}.jpg`);
          await fetch(
            `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${fileName}`,
            { method: 'DELETE' }
          ).catch(() => {});
        }
      }

      // Deleta documento do Firestore
      await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/jobs/${jobId}`,
        { method: 'DELETE' }
      ).catch(() => {});
    }

    console.log(`Limpeza: ${data.filter(i => i.document).length} jobs removidos`);
  } catch (e) {
    console.error('Erro na limpeza:', e.message);
  }
}

// ── FUNÇÃO INNGEST DE LIMPEZA (roda diariamente) ──────────
const limparStorage = inngest.createFunction(
  { id: 'limpar-storage', retries: 1 },
  { cron: '0 3 * * *' }, // Todo dia às 3h da manhã
  async () => {
    await limparJobsAntigos();
  }
);
  { id: 'gerar-fotos', retries: 2, timeouts: { finish: '10m' } },
  { event: 'vitrio/gerar' },
  async ({ event, step }) => {
    const { jobId, imageBase64, prompts, selectedPhotos } = event.data;
    await updateJob(jobId, { status: 'processing', updatedAt: Date.now() });

    const analise = await step.run('analisar', async () => {
      try { return await analisarPeca(imageBase64); } catch { return {}; }
    });
    const descricao = montarDescricao(analise);

    let photo1B64 = null;
    if (selectedPhotos.includes(1)) {
      photo1B64 = await step.run('foto-1', async () => {
        const b64 = await gerarFoto(prompts[1], imageBase64, descricao);
        const url = await salvarImagem(jobId, 1, b64);
        await updateJob(jobId, { 1: url, updatedAt: Date.now() });
        return b64;
      });
    }

    const ref = photo1B64 || imageBase64;
    if (selectedPhotos.includes(2)) {
      await step.run('foto-2', async () => {
        const b64 = await gerarFoto(prompts[2], ref, descricao);
        const url = await salvarImagem(jobId, 2, b64);
        await updateJob(jobId, { 2: url, updatedAt: Date.now() });
      });
    }
    if (selectedPhotos.includes(3)) {
      await step.run('foto-3', async () => {
        const b64 = await gerarFoto(prompts[3], ref, descricao);
        const url = await salvarImagem(jobId, 3, b64);
        await updateJob(jobId, { 3: url, updatedAt: Date.now() });
      });
    }

    await updateJob(jobId, { status: 'completed', updatedAt: Date.now() });
  }
);

module.exports = serve({
  client: inngest,
  functions: [gerarFotos, limparStorage],
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
