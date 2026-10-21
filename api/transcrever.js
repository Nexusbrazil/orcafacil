// /api/transcrever.js
// POST multipart/form-data → Whisper via Omniroute autenticado com OMNIROUTE_API_KEY.

export const config = {
  api: {
    bodyParser: false,
  },
};

const CAMPOS_ARQUIVO = new Set(['file', 'audio', 'audio_file', 'arquivo', 'recording', 'uploaded_file']);

function aplicarCors(req, res) {
  const requested = req.headers?.['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    requested || 'Content-Type, Authorization, Accept, X-Requested-With, Origin',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(req, res, status, payload) {
  aplicarCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(status).json(payload);
  }
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function lerOmnirouteKey() {
  return String(process.env.OMNIROUTE_API_KEY || '').trim();
}

function erroChaveAusente() {
  return {
    erro: 'OMNIROUTE_API_KEY não configurada no servidor.',
    dica: 'Em Vercel → Project → Settings → Environment Variables, crie OMNIROUTE_API_KEY e faça um novo deploy.',
  };
}

function extensaoPorMime(mimeType, filename = '') {
  const nome = String(filename).toLowerCase();
  if (/\.(webm|wav|mp3|m4a|mp4|ogg|flac|mpeg|mpga)$/.test(nome)) return nome.slice(nome.lastIndexOf('.'));

  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('m4a') || mime.includes('mp4') || mime.includes('aac')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('flac')) return '.flac';
  return '.webm';
}

function lerBuffer(req, maxBytes) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > maxBytes) {
      const erro = new Error('AUDIO_TOO_LARGE');
      erro.status = 413;
      return Promise.reject(erro);
    }
    return Promise.resolve(req.body);
  }

  if (typeof req.body === 'string') {
    const buf = Buffer.from(req.body);
    if (buf.length > maxBytes) {
      const erro = new Error('AUDIO_TOO_LARGE');
      erro.status = 413;
      return Promise.reject(erro);
    }
    return Promise.resolve(buf);
  }

  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let tamanho = 0;
    const timer = setTimeout(() => reject(new Error('TIMEOUT_BODY')), 15_000);

    req.on('data', (chunk) => {
      tamanho += chunk.length;
      if (tamanho > maxBytes) {
        clearTimeout(timer);
        const erro = new Error('AUDIO_TOO_LARGE');
        erro.status = 413;
        reject(erro);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (erro) => {
      clearTimeout(timer);
      reject(erro);
    });
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return { fields: {}, files: [] };

  const boundary = (match[1] || match[2]).trim();
  const delim = Buffer.from(`\r\n--${boundary}`);
  const prefix = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let cursor = buffer.indexOf(prefix);
  if (cursor < 0) return { fields, files };
  cursor += prefix.length;
  if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;

  while (cursor < buffer.length) {
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;

    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(delim, headerEnd + 4);
    if (next < 0) break;

    const body = buffer.slice(headerEnd + 4, next);
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const filenameMatch = /filename\*?=(?:UTF-8''|")?([^";\r\n]*)/i.exec(headers);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
    const name = nameMatch ? nameMatch[1] : '';
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1].replace(/"/g, '')) : '';
    const mimeType = typeMatch ? typeMatch[1].trim() : '';
    const pareceArquivo = Boolean(filenameMatch) || CAMPOS_ARQUIVO.has(name) || mimeType.startsWith('audio/');

    if (pareceArquivo && body.length) {
      files.push({
        fieldName: name,
        filename: filename || 'audio.webm',
        mimeType: mimeType || 'application/octet-stream',
        buffer: body,
      });
    } else if (name) {
      fields[name] = body.toString('utf8');
    }

    cursor = next + delim.length;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
  }

  return { fields, files };
}

function escolherArquivo(files, fields) {
  const direto = files.find((f) => CAMPOS_ARQUIVO.has(f.fieldName)) || files[0];
  if (direto?.buffer?.length) return direto;

  const base64 =
    fields.audio_base64 ||
    fields.audioBase64 ||
    fields.file_base64 ||
    fields.base64;

  if (base64) {
    const limpo = String(base64).replace(/^data:[^;]+;base64,/, '');
    return {
      fieldName: 'file',
      filename: fields.filename || 'audio.webm',
      mimeType: fields.mime_type || fields.mimeType || 'audio/webm',
      buffer: Buffer.from(limpo, 'base64'),
    };
  }

  return null;
}

function audioDeJson(body) {
  if (!body || typeof body !== 'object') return null;

  const base64 = body.audio_base64 || body.audioBase64 || body.file_base64 || body.base64 || body.audio;
  if (typeof base64 !== 'string' || !base64.trim()) return null;
  if (base64.startsWith('http')) return null;

  const limpo = base64.replace(/^data:[^;]+;base64,/, '');
  return {
    filename: body.filename || 'audio.webm',
    mimeType: body.mime_type || body.mimeType || 'audio/webm',
    buffer: Buffer.from(limpo, 'base64'),
  };
}

function arquivoParaWhisper(audio) {
  const filename = `audio${extensaoPorMime(audio.mimeType, audio.filename)}`;
  const bytes = new Uint8Array(audio.buffer.buffer, audio.buffer.byteOffset, audio.buffer.byteLength);
  const type = audio.mimeType || 'application/octet-stream';

  if (typeof File === 'function') {
    return new File([bytes], filename, { type });
  }

  const blob = new Blob([bytes], { type });
  blob.name = filename;
  return blob;
}

async function transcreverComModelo(audio, modelo, apiKey, baseUrl) {
  const form = new FormData();
  const arquivo = arquivoParaWhisper(audio);
  const filename = arquivo.name || `audio${extensaoPorMime(audio.mimeType, audio.filename)}`;

  form.append('file', arquivo, filename);
  form.append('model', modelo);
  form.append('language', process.env.WHISPER_LANGUAGE || 'pt');
  form.append('response_format', 'json');

  const resposta = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(Number(process.env.WHISPER_TIMEOUT_MS || 50000)),
  });

  const bruto = await resposta.text();
  let parsed = {};
  try {
    parsed = bruto ? JSON.parse(bruto) : {};
  } catch {
    parsed = { raw: bruto };
  }

  if (!resposta.ok) {
    const erro = new Error(parsed.error?.message || parsed.erro || `Whisper HTTP ${resposta.status}`);
    erro.status = resposta.status;
    throw erro;
  }

  const texto = String(parsed.text || parsed.texto || '').trim();
  if (!texto) {
    const erro = new Error('Transcrição vazia.');
    erro.status = 422;
    throw erro;
  }

  return texto;
}

export default async function handler(req, res) {
  try {
    aplicarCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      return res.end();
    }

    const apiKey = lerOmnirouteKey();
    const maxAudioBytes = Number(process.env.MAX_AUDIO_BYTES || 4.5 * 1024 * 1024);

    if (req.method === 'GET') {
      return json(req, res, apiKey ? 200 : 500, {
        ok: Boolean(apiKey),
        servico: 'transcrever',
        omniroute_configurada: Boolean(apiKey),
        metodo: 'POST multipart/form-data no campo "file" (ou "audio")',
        ...(apiKey ? {} : erroChaveAusente()),
      });
    }

    if (req.method !== 'POST') {
      return json(req, res, 405, { erro: 'Método não permitido. Use POST.' });
    }

    if (!apiKey) {
      return json(req, res, 500, erroChaveAusente());
    }

    const contentType = String(req.headers['content-type'] || '');
    let audio = null;

    if (contentType.includes('multipart/form-data')) {
      const bruto = await lerBuffer(req, maxAudioBytes);
      const parsed = parseMultipart(bruto, contentType);
      audio = escolherArquivo(parsed.files, parsed.fields);
    } else if (contentType.includes('application/json')) {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || Buffer.isBuffer(body) || typeof body !== 'object') {
        const bruto = await lerBuffer(req, maxAudioBytes);
        body = bruto.length ? JSON.parse(bruto.toString('utf8')) : {};
      }
      audio = audioDeJson(body);
    } else if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
      const buffer = await lerBuffer(req, maxAudioBytes);
      audio = { filename: 'audio', mimeType: contentType, buffer };
    }

    if (!audio?.buffer?.length) {
      return json(req, res, 400, {
        erro: 'Envie o áudio em multipart/form-data no campo "file" (ou "audio").',
      });
    }

    if (audio.buffer.length > maxAudioBytes) {
      return json(req, res, 413, {
        erro: `Áudio acima do limite de ${Math.round(maxAudioBytes / (1024 * 1024))}MB da Vercel.`,
      });
    }

    const baseUrl = String(process.env.OMNIROUTE_URL || 'https://api.omniroute.ai').replace(/\/$/, '');
    const tentativas = [...new Set([
      process.env.WHISPER_MODEL,
      'whisper-1',
      'openai/whisper-1',
    ].filter(Boolean))];

    let ultimoErro = null;

    for (const modelo of tentativas) {
      try {
        const texto = await transcreverComModelo(audio, modelo, apiKey, baseUrl);
        return json(req, res, 200, { texto });
      } catch (erro) {
        ultimoErro = erro;
        console.warn(`[transcrever] Falha no modelo ${modelo}:`, erro.message);
      }
    }

    return json(req, res, ultimoErro?.status && ultimoErro.status < 500 ? ultimoErro.status : 502, {
      erro: 'Falha ao transcrever o áudio.',
      detalhe: ultimoErro?.message || 'Desconhecido',
    });
  } catch (erro) {
    if (erro.status === 413 || erro.message === 'AUDIO_TOO_LARGE') {
      return json(req, res, 413, {
        erro: 'Áudio acima do limite permitido pela Vercel (~4.5MB no plano Hobby).',
      });
    }

    console.error('[transcrever] Erro inesperado:', erro);
    return json(req, res, 500, {
      erro: 'Erro interno ao transcrever o áudio.',
      detalhe: erro.message || 'Desconhecido',
    });
  }
}
