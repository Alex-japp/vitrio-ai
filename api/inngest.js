const { Inngest } = require('inngest');
const { serve } = require('inngest/express');
const { getServiceAccountToken } = require('./auth-helper');
const sharp = require('sharp');

const inngest = new Inngest({
  id: 'vitrio-ai',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

const BUCKET = `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`;

// ── Firestore: lê documento ──────────────────────────────
async function firestoreGet(accessToken, docPath) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Firestore GET falhou (${res.status}): ${await res.text()}`);
  return res.json();
}

// ── Firestore: atualiza campos específicos ───────────────
async function updateJob(accessToken, jobId, updates) {
  const fields = {};
  const fieldPaths = [];
  // Campos que usam nome direto (sem prefixo photo_)
  const directFields = new Set(['status', 'updatedAt', 'fichaTecnica']);
  Object.entries(updates).forEach(([k, v]) => {
    const fieldName = directFields.has(k) ? k : `photo_${k}`;
    fieldPaths.push(fieldName);
    if (k === 'updatedAt')        fields[fieldName] = { integerValue: v.toString() };
    else if (k === 'fichaTecnica') fields[fieldName] = { stringValue: JSON.stringify(v) };
    else                           fields[fieldName] = { stringValue: v };
  });
  const maskParams = fieldPaths.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}?${maskParams}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ fields })
    }
  );
  if (!res.ok) console.error('updateJob erro:', res.status, await res.text());
}

// ── Storage: baixa imagem → base64 ──────────────────────
async function downloadFromStorage(accessToken, filePath) {
  const encoded = encodeURIComponent(filePath);
  const url     = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encoded}?alt=media`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Storage download falhou (${res.status}): ${filePath}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── Comprime para JPEG via sharp ─────────────────────────
async function comprimirParaJpeg(b64) {
  try {
    const buffer = Buffer.from(b64, 'base64');
    const compressed = await sharp(buffer)
      .jpeg({ quality: 93, progressive: true })
      .toBuffer();
    return compressed.toString('base64');
  } catch (e) {
    console.warn('Compressão sharp falhou, usando original:', e.message);
    return b64;
  }
}

// ── Storage: salva por número (photo_1, photo_2...) ──────
async function salvarImagem(accessToken, jobId, photoNum, b64) {
  const filePath = `jobs/${jobId}/photo_${photoNum}.jpg`;
  return await salvarImagemDireto(accessToken, filePath, b64);
}

// ── Storage: salva em path específico ───────────────────
async function salvarImagemDireto(accessToken, filePath, b64) {
  const encoded = encodeURIComponent(filePath);
  const url     = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encoded}`;
  const b64Comprimido = await comprimirParaJpeg(b64);
  const buffer = Buffer.from(b64Comprimido, 'base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'image/jpeg',
    },
    body: buffer
  });
  if (!res.ok) throw new Error(`Storage upload falhou (${res.status}): ${await res.text()}`);
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encoded}?alt=media`;
}

// ── Análise técnica da peça ──────────────────────────────
async function analisarPeca(imageBase64) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
      max_tokens: 900,
      messages: [{
        role:    'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          { type: 'text', text: `Analise esta joia com máxima precisão e retorne APENAS JSON, sem texto antes ou depois:
{
  "metal": "ouro|prata|rose_gold",
  "acabamento": "polido|fosco|texturizado",
  "productType": "anel|colar|brinco|pulseira|argola|tornozeleira|pingente|conjunto|corrente|berloque|cinto|bolsa|oculos",
  "mainShape": "formato principal da peça ex: cruz, coração, aro simples, elo, oval, redondo, quadrado, borboleta",
  "structure": "descrição da estrutura ex: aro duplo aberto, banda larga, corrente singela, elo canalizado",
  "pedras": true,
  "tipo_pedra": "cristal|zirconia|perola|sem_pedra",
  "quantidade_pedras": 0,
  "stonePlacement": "onde as pedras estão posicionadas ex: toda a extensão, parte frontal, centro, bordas",
  "perolas": false,
  "quantidade_perolas": 0,
  "tipo_elo": "retangular|oval|figaro|sem_elo",
  "espessura_elo": "fina|media|grossa",
  "fecho": "lagosta|mola|gaveta|sem_fecho",
  "pingente": false,
  "tipo_pingente": "sem_pingente",
  "gravacao": false,
  "importantDetails": ["detalhe 1", "detalhe 2"],
  "forbiddenChanges": ["não alterar a cor do metal", "não mudar quantidade de pedras", "não alterar formato principal"],
  "technicalDescription": "descrição curta e precisa da peça em 1 frase",
  "detalhes_extras": ""
}
Seja preciso. importantDetails deve listar características visuais únicas da peça. forbiddenChanges deve listar o que não pode ser alterado na geração.
Adicione também:
  "complexity": "simple|medium|complex",
  "fidelityMode": "normal|strict"
complexity = simple: peça lisa sem símbolos ou pedras. medium: algumas pedras ou textura. complex: símbolo específico, múltiplos aros, muitas pedras, letras, formatos geométricos únicos.
fidelityMode = strict quando complexity = complex ou quando há símbolo, gravação, formato específico ou estrutura incomum. normal nos demais casos.` }
        ]
      }]
    })
  });
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return {}; }
}

// ── Mapeia metalColor → label legível para o prompt ──
function resolverCorFinal(metalColor, analise) {
  if (metalColor === 'gold')      return 'DOURADO';
  if (metalColor === 'silver')    return 'PRATA';
  if (metalColor === 'rose_gold') return 'ROSE GOLD';
  const map = { ouro: 'DOURADO', prata: 'PRATA', rose_gold: 'ROSE GOLD' };
  return map[analise.metal] || 'DOURADO';
}

// ── Monta contexto mínimo e cirúrgico para injetar no prompt ──
function montarContexto(analise, corFinal) {
  const partes = [];

  // Bloco 1 — Ficha mínima (máx 6 campos, sem repetição)
  const ficha = [];
  if (analise.productType)    ficha.push(`Tipo: ${analise.productType}`);
  ficha.push(`Cor: ${corFinal}`);
  if (analise.structure)      ficha.push(`Estrutura: ${analise.structure}`);
  if (analise.mainShape)      ficha.push(`Elemento principal: ${analise.mainShape}`);
  if (analise.pedras && analise.tipo_pedra !== 'sem_pedra')
    ficha.push(`Pedras: ${analise.quantidade_pedras} ${analise.tipo_pedra}${analise.stonePlacement ? ' — ' + analise.stonePlacement : ''}`);
  if (analise.importantDetails?.length > 0)
    ficha.push(`Detalhes críticos: ${analise.importantDetails.slice(0, 3).join(', ')}`);

  partes.push('Peça: ' + ficha.join(' | '));

  // Bloco 2 — Proibições críticas (máx 4 itens, sem repetir o que já está na ficha)
  const proibicoes = (analise.forbiddenChanges || []).slice(0, 4);
  if (proibicoes.length > 0)
    partes.push('Não alterar: ' + proibicoes.join('. '));

  return '\n' + partes.join('\n');
}

// ── Fallback FLUX ────────────────────────────────────────
async function gerarFLUX(prompt, imageBase64) {
  if (!process.env.REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY não configurada.');
  const startRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-redux-dev/predictions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}`,
      'Prefer':        'wait'
    },
    body: JSON.stringify({
      input: {
        redux_image:    `data:image/jpeg;base64,${imageBase64}`,
        prompt,
        num_outputs:    1,
        aspect_ratio:   '1:1',
        output_format:  'webp',
        output_quality: 90
      }
    })
  });
  if (!startRes.ok) throw new Error(`FLUX erro: ${startRes.status}`);
  const prediction = await startRes.json();
  if (prediction.output?.[0]) {
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

// ── Geração de foto (OpenAI + fallback FLUX) ─────────────
async function gerarFoto(prompt, imageBase64, descricao = '', retries = 3, quality = 'medium') {
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [{
          role:    'user',
          content: [
            { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` },
            { type: 'input_text', text: `Reproduza EXATAMENTE este produto. Aplique: ${prompt + descricao}` }
          ]
        }],
        tools: [{ type: 'image_generation', size: '1024x1024', quality }]
      })
    });
    if (response.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, 15000));
      return gerarFoto(prompt, imageBase64, descricao, retries - 1, quality);
    }
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const data = await response.json();
    const img  = data.output?.find(o => o.type === 'image_generation_call');
    if (!img) throw new Error('Imagem não gerada');
    return img.result;
  } catch (openaiError) {
    console.warn('OpenAI falhou, tentando FLUX:', openaiError.message);
    return gerarFLUX(prompt, imageBase64);
  }
}

// ── Limpeza automática de jobs antigos (24h) ─────────────
async function limparJobsAntigos(accessToken) {
  try {
    const vinte4h = Date.now() - (24 * 60 * 60 * 1000);
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'jobs' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'createdAt' },
                op:    'LESS_THAN',
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
      const jobId  = item.document.name.split('/').pop();
      const fields = item.document.fields || {};
      for (let n = 1; n <= 6; n++) {
        if (fields[`photo_${n}`]?.stringValue) {
          const fileName = encodeURIComponent(`jobs/${jobId}/photo_${n}.jpg`);
          await fetch(
            `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${fileName}`,
            { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` } }
          ).catch(() => {});
        }
      }
      // Deleta photo_ref.jpg também
      const refFileName = encodeURIComponent(`jobs/${jobId}/photo_ref.jpg`);
      await fetch(
        `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${refFileName}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` } }
      ).catch(() => {});
      const origFileName = encodeURIComponent(`jobs/${jobId}/original.jpg`);
      await fetch(
        `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${origFileName}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` } }
      ).catch(() => {});
      await fetch(
        `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` } }
      ).catch(() => {});
    }
    console.log(`Limpeza: ${data.filter(i => i.document).length} jobs removidos`);
  } catch (e) {
    console.error('Erro na limpeza:', e.message);
  }
}

// ── Função Inngest: limpeza diária ───────────────────────
const limparStorage = inngest.createFunction(
  { id: 'limpar-storage', retries: 1 },
  { cron: '0 3 * * *' },
  async () => {
    const accessToken = await getServiceAccountToken();
    await limparJobsAntigos(accessToken);
  }
);

// ── Função Inngest: geração de fotos ─────────────────────
const gerarFotos = inngest.createFunction(
  { id: 'gerar-fotos', retries: 2, timeouts: { finish: '10m' } },
  { event: 'vitrio/gerar' },
  async ({ event, step }) => {
    const { jobId } = event.data;
    if (!jobId) throw new Error('jobId não fornecido');
    const accessToken = await getServiceAccountToken();

    // ── Step 1: Busca job no Firestore ───────────────────
    const jobDoc = await step.run('buscar-job', async () => {
      const doc    = await firestoreGet(accessToken, `jobs/${jobId}`);
      const fields = doc.fields || {};
      return {
        imageFilePath:  fields.imageFilePath?.stringValue,
        selectedPhotos: (fields.selectedPhotos?.arrayValue?.values || [])
                          .map(v => parseInt(v.integerValue)),
        prompts:        Object.fromEntries(
                          Object.entries(fields.prompts?.mapValue?.fields || {})
                            .map(([k, v]) => [k, v.stringValue])
                        ),
        metalColor:     fields.metalColor?.stringValue || 'auto'
      };
    });

    await updateJob(accessToken, jobId, { status: 'processing', updatedAt: Date.now() });

    // ── Step 2: Baixa imagem original do Storage ─────────
    const imageBase64 = await step.run('baixar-imagem', async () => {
      return await downloadFromStorage(accessToken, jobDoc.imageFilePath);
    });

    // ── Step 3: Análise técnica da peça ──────────────────
    const analise = await step.run('analisar', async () => {
      try { return await analisarPeca(imageBase64); } catch { return {}; }
    });

    const { selectedPhotos, prompts, metalColor } = jobDoc;
    const corFinal = resolverCorFinal(metalColor, analise);
    const contexto = montarContexto(analise, corFinal);
    const isComplexo = analise.fidelityMode === 'strict' || analise.complexity === 'complex';

    // ── Salva análise no Firestore (para debug) ───────────
    await updateJob(accessToken, jobId, { fichaTecnica: analise, updatedAt: Date.now() });

    // ── Step 4: Gerar Foto 1 — high se complexo, medium se simples ──
    // photo_ref.jpg é SEMPRE gerado — é a referência oficial
    await step.run('foto-1', async () => {
      const promptFinal = prompts['1'] + contexto;
      const qualidadeFoto1 = isComplexo ? 'high' : 'medium';
      const b64 = await gerarFoto(promptFinal, imageBase64, '', 3, qualidadeFoto1);

      // Salva SEMPRE como photo_ref.jpg — referência interna obrigatória
      await salvarImagemDireto(accessToken, `jobs/${jobId}/photo_ref.jpg`, b64);

      // Salva como photo_1.jpg APENAS se usuário selecionou catálogo
      if (selectedPhotos.includes(1)) {
        const url = await salvarImagem(accessToken, jobId, 1, b64);
        await updateJob(accessToken, jobId, { 1: url, updatedAt: Date.now() });
      }
    });

    // ── Step 5: Baixa photo_ref.jpg — referência oficial ─
    const refB64 = await step.run('baixar-ref', async () => {
      return await downloadFromStorage(accessToken, `jobs/${jobId}/photo_ref.jpg`);
    });

    // ── Fotos 2-6 usam exclusivamente photo_ref.jpg ──────
    if (selectedPhotos.includes(2)) {
      await step.run('foto-2', async () => {
        const b64 = await gerarFoto(prompts['2'] + contexto, refB64, '', 3, 'medium');
        const url = await salvarImagem(accessToken, jobId, 2, b64);
        await updateJob(accessToken, jobId, { 2: url, updatedAt: Date.now() });
      });
    }

    if (selectedPhotos.includes(3)) {
      await step.run('foto-3', async () => {
        const b64 = await gerarFoto(prompts['3'] + contexto, refB64, '', 3, 'medium');
        const url = await salvarImagem(accessToken, jobId, 3, b64);
        await updateJob(accessToken, jobId, { 3: url, updatedAt: Date.now() });
      });
    }

    if (selectedPhotos.includes(4)) {
      await step.run('foto-4', async () => {
        const b64 = await gerarFoto(prompts['4'] + contexto, refB64, '', 3, 'medium');
        const url = await salvarImagem(accessToken, jobId, 4, b64);
        await updateJob(accessToken, jobId, { 4: url, updatedAt: Date.now() });
      });
    }

    if (selectedPhotos.includes(5)) {
      await step.run('foto-5', async () => {
        const b64 = await gerarFoto(prompts['5'] + contexto, refB64, '', 3, 'medium');
        const url = await salvarImagem(accessToken, jobId, 5, b64);
        await updateJob(accessToken, jobId, { 5: url, updatedAt: Date.now() });
      });
    }

    if (selectedPhotos.includes(6)) {
      await step.run('foto-6', async () => {
        const b64 = await gerarFoto(prompts['6'] + contexto, refB64, '', 3, 'medium');
        const url = await salvarImagem(accessToken, jobId, 6, b64);
        await updateJob(accessToken, jobId, { 6: url, updatedAt: Date.now() });
      });
    }

    await updateJob(accessToken, jobId, { status: 'completed', updatedAt: Date.now() });
  }
);

module.exports = serve({
  client:    inngest,
  functions: [gerarFotos, limparStorage],
});
