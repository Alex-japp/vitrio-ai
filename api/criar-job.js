module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { imageBase64, prompts, selectedPhotos, userId, code } = req.body;
  if (!imageBase64 || !prompts || !selectedPhotos) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    // Cria job no Firestore
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/jobs/${jobId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            status: { stringValue: 'pending' },
            userId: { stringValue: userId || '' },
            code: { stringValue: code || '' },
            createdAt: { integerValue: Date.now().toString() },
            updatedAt: { integerValue: Date.now().toString() }
          }
        })
      }
    );

    // Dispara evento no Inngest
    const inngestRes = await fetch('https://inn.gs/e/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INNGEST_EVENT_KEY}`
      },
      body: JSON.stringify({
        name: 'vitrio/gerar',
        data: { jobId, imageBase64, prompts, selectedPhotos, userId: userId || '', code: code || '' }
      })
    });

    if (!inngestRes.ok) {
      const err = await inngestRes.text();
      console.error('Inngest erro:', err);
      return res.status(500).json({ error: 'Erro ao enviar para fila: ' + err });
    }

    return res.status(200).json({ jobId });
  } catch (e) {
    console.error('Erro criar-job:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
