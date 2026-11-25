// =====================================================================
//  Creá tu sticker — bot de WhatsApp
//  Le mandás un link de X/TikTok (o un video) y te devuelve un
//  sticker CON SONIDO.
//
//  Uso:  node bot.mjs            (la primera vez muestra un QR)
//  Ojo:  usa un cliente no oficial de WhatsApp. Usá un número aparte.
// =====================================================================
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, downloadMediaMessage,
  prepareWAMessageMedia, generateMessageIDV2, proto, Browsers, fetchLatestBaileysVersion,
} from 'baileys';
import pino from 'pino';
import protobuf from 'protobufjs/minimal.js';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const run = promisify(execFile);
const { Writer } = protobuf;
const MAX_SEG = 5;                 // WhatsApp guarda hasta 5 s de audio en stickers de video
const MAX_WEBP = 900 * 1024;       // el servidor rechaza stickers de más de 1 MB
const PAGINA = 'https://marcosgrandoli.github.io/crea-tu-sticker/';
const log = (...a) => console.log(new Date().toLocaleTimeString('es-AR'), ...a);

// ---------------------------------------------------------------------
// 1) Formato "sticker con sonido"
//    Message.audioStickerMessage (134) = FutureProofMessage { message (1) }
//      └ Message.stickerMessage (26) con dos campos nuevos:
//          StickerMessage.emojis (25) y StickerMessage.audioMessage (26)
//    La librería todavía no los conoce, así que esos bytes los
//    escribimos a mano y le enseñamos a proto.Message.encode a usarlos.
// ---------------------------------------------------------------------
const origEncode = proto.Message.encode.bind(proto.Message);
proto.Message.encode = function (message, writer) {
  if (message && message.__audioStickerBytes) {
    const w = writer || Writer.create();
    w.uint32((134 << 3) | 2).bytes(message.__audioStickerBytes);
    return w;
  }
  return origEncode(message, writer);
};
function campoBytes(n, buf) {            // tag + largo + bytes (campo tipo 2)
  return Buffer.from(Writer.create().uint32((n << 3) | 2).bytes(buf).finish());
}
function campoTexto(n, s) {
  return Buffer.from(Writer.create().uint32((n << 3) | 2).string(s).finish());
}
function armarAudioSticker(stickerMessage, audioMessage, emojis = '🔊') {
  const base = Buffer.from(proto.Message.StickerMessage.encode(stickerMessage).finish());
  const audio = Buffer.from(proto.Message.AudioMessage.encode(audioMessage).finish());
  const sticker = Buffer.concat([base, campoTexto(25, emojis), campoBytes(26, audio)]);
  const mensaje = campoBytes(26, sticker);           // Message.stickerMessage
  return campoBytes(1, mensaje);                     // FutureProofMessage.message
}

// ---------------------------------------------------------------------
// 2) Conversión con FFmpeg
// ---------------------------------------------------------------------
// EXIF de sticker de WhatsApp (tag 0x5741) con el hash del sonido
function exifSticker(soundSha256) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': randomUUID(),
    'sticker-pack-name': 'Creá tu sticker',
    'sticker-pack-publisher': 'creatusticker.com',
    'emojis': ['🔊'],
    'sound-sha256': soundSha256,
  }), 'utf8');
  const head = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  head.writeUInt32LE(json.length, 14);
  return Buffer.concat([head, json]);
}
// Mete el EXIF en un WebP animado (chunk VP8X + chunk EXIF)
function webpConExif(webp, exif) {
  if (webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 12, 16) !== 'VP8X') return webp;
  const out = Buffer.from(webp);
  out[20] |= 0x08;                                   // flag "tiene EXIF"
  const pad = exif.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const chunk = Buffer.concat([Buffer.from('EXIF'), Buffer.alloc(4), exif, pad]);
  chunk.writeUInt32LE(exif.length, 4);
  const total = Buffer.concat([out, chunk]);
  total.writeUInt32LE(total.length - 8, 4);
  return total;
}

async function convertir(entrada, { desde = 0, dura = MAX_SEG, conAudio = true }) {
  const dir = await mkdtemp(join(tmpdir(), 'cts-'));
  try {
    const recorte = ['-ss', String(desde), '-t', String(Math.min(dura, MAX_SEG)), '-i', entrada];
    // Sticker animado: 512x512 llenando el cuadro; bajamos calidad/fps hasta que entre
    let webp;
    for (const [fps, q] of [[15, 60], [12, 45], [10, 35], [8, 25]]) {
      const out = join(dir, 's.webp');
      await run(ffmpegPath, ['-y', ...recorte, '-an', '-vf',
        `fps=${fps},scale=512:512:force_original_aspect_ratio=increase,crop=512:512`,
        '-c:v', 'libwebp_anim', '-loop', '0', '-lossless', '0', '-q:v', String(q), '-preset', 'picture', out]);
      webp = await readFile(out);
      if (webp.length <= MAX_WEBP) break;
    }
    let ogg = null, segundos = 0;
    if (conAudio) {
      const out = join(dir, 'a.ogg');
      try {
        await run(ffmpegPath, ['-y', ...recorte, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', out]);
        ogg = await readFile(out);
        if (ogg.length < 2000) ogg = null;          // el video no tenía audio
        segundos = Math.max(1, Math.round(Math.min(dura, MAX_SEG)));
      } catch { ogg = null; }
    }
    if (ogg) webp = webpConExif(webp, exifSticker(createHash('sha256').update(ogg).digest('base64')));
    return { webp, ogg, segundos };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------
// 3) Traer videos de X y TikTok (mismos servicios gratis que la página)
// ---------------------------------------------------------------------
async function bajarVideo(link) {
  let url;
  if (/tiktok\.com/i.test(link)) {
    const j = await (await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(link)}`)).json();
    if (j.code !== 0 || !j.data?.play) throw new Error('TikTok no devolvió ese video');
    url = j.data.play.startsWith('http') ? j.data.play : 'https://www.tikwm.com' + j.data.play;
  } else {
    const id = (link.match(/status(?:es)?\/(\d+)/) || [])[1];
    if (!id) throw new Error('No encontré el video en ese link');
    const j = await (await fetch(`https://api.fxtwitter.com/i/status/${id}`)).json();
    const m = j.tweet?.media; const v = m?.videos?.[0] || m?.all?.find(x => x.type === 'video' || x.type === 'gif');
    if (!v) throw new Error('Ese post no tiene video');
    const mp4s = (v.formats || []).filter(x => x.container === 'mp4' && x.url).sort((a, b) => a.bitrate - b.bitrate);
    url = (mp4s.filter(x => x.bitrate <= 1_200_000).pop() || mp4s[0])?.url || v.url;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('No se pudo bajar el video');
  return Buffer.from(await r.arrayBuffer());
}

// Lee "desde 10s", "dura 3s", "sin audio" del mensaje (lo arma la página)
function leerOpciones(texto = '') {
  const n = (re) => { const m = texto.match(re); return m ? parseFloat(m[1].replace(',', '.')) : null; };
  return {
    desde: n(/desde\s*(\d+(?:[.,]\d+)?)/i) ?? 0,
    dura: n(/dura\s*(\d+(?:[.,]\d+)?)/i) ?? MAX_SEG,
    conAudio: !/sin\s*audio/i.test(texto),
  };
}

// ---------------------------------------------------------------------
// 4) Enviar
// ---------------------------------------------------------------------
async function enviarSticker(sock, jid, { webp, ogg, segundos }, citado) {
  const subir = { upload: sock.waUploadToServer };
  const { stickerMessage } = await prepareWAMessageMedia({ sticker: webp }, subir);
  stickerMessage.isAnimated = true; stickerMessage.width = 512; stickerMessage.height = 512;
  if (citado) stickerMessage.contextInfo = { stanzaId: citado.key.id, participant: citado.key.participant || citado.key.remoteJid, quotedMessage: citado.message };
  const id = generateMessageIDV2(sock.user?.id); enviados.add(id);
  if (!ogg) {
    await sock.relayMessage(jid, { stickerMessage }, { messageId: id });
    return false;
  }
  const { audioMessage } = await prepareWAMessageMedia({ audio: ogg, mimetype: 'audio/ogg; codecs=opus' }, subir);
  audioMessage.seconds = segundos; audioMessage.ptt = false;
  const bytes = armarAudioSticker(stickerMessage, audioMessage);
  // stickerMessage queda para que la librería marque el envío como "sticker"
  await sock.relayMessage(jid, { stickerMessage, __audioStickerBytes: bytes }, { messageId: id });
  return true;
}

// ---------------------------------------------------------------------
// 5) Conexión y mensajes
// ---------------------------------------------------------------------
const AYUDA = `👋 *Creá tu sticker*\n\nMandame:\n• un *link de X o TikTok*, o\n• un *video* (hasta 5 s se usan)\n\ny te devuelvo el sticker *con sonido* 🔊\n\nPara elegir la parte del video usá la página: ${PAGINA}`;
let cola = Promise.resolve();
// --personal: conectado a TU número, solo responde en tu chat "Mensajes para mí"
const PERSONAL = process.argv.includes('--personal');
const enviados = new Set();
// Mensaje de "es gratis" después del sticker (una vez por día por persona).
// Cuando tengas Cafecito, poné tu link en CAFECITO.
const CAFECITO = process.env.CAFECITO || '';
const avisados = new Map();
async function avisoGratis(sock, jid) {
  const ahora = Date.now();
  if (ahora - (avisados.get(jid) || 0) < 24 * 60 * 60 * 1000) return;
  avisados.set(jid, ahora);
  let t = '🎁 Esto es *gratis*: no se cobra nada, ni ahora ni después.';
  if (CAFECITO) t += `\n☕ Si te gustó y querés bancar el proyecto, podés invitarnos un cafecito: ${CAFECITO}`;
  t += '\n\nTocá el sticker y marcalo como ⭐ favorito para usarlo cuando quieras.';
  await sock.sendMessage(jid, { text: t });
}
// --numero 54911XXXXXXXX: vincular con código de 8 letras en vez de QR
const NUMERO = (process.argv[process.argv.indexOf('--numero') + 1] || '').replace(/\D/g, '') || (process.argv.includes('--numero') ? '' : '');
let pidioCodigo = false;

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); log('Versión de WhatsApp Web:', version.join('.')); } catch { log('No pude ver la versión actual, uso la de la librería'); }
  const sock = makeWASocket({
    auth: state, ...(version ? { version } : {}), logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'), markOnlineOnConnect: false, syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);
  const mandarOrig = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...a) => { const r = await mandarOrig(...a); if (r?.key?.id) enviados.add(r.key.id); return r; };
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && NUMERO && !state.creds.registered && !pidioCodigo) {
      pidioCodigo = true;
      sock.requestPairingCode(NUMERO).then(c => console.log(`\nEn tu celular: Dispositivos vinculados → Vincular un dispositivo → "Vincular con número de teléfono" y escribí este código:\n\n      ${c.slice(0, 4)}-${c.slice(4)}\n`)).catch(e => log('No pude pedir el código:', e.message));
      return;
    }
    if (qr && !NUMERO) {
      QRCode.toFile('qr.png', qr, { width: 600, margin: 3 }).then(() => log('QR nuevo guardado en qr.png')).catch(() => {}); console.log('\nEscaneá este QR con el WhatsApp DEL BOT (Dispositivos vinculados → Vincular):\n'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') log('✅ Bot conectado como', sock.user?.id, PERSONAL ? '(modo personal: solo tu chat "Mensajes para mí")' : '');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { log('❌ Sesión cerrada desde el teléfono. Borrá la carpeta auth y volvé a escanear.'); return; }
      log(`Conexión cerrada (código ${code ?? '?'}: ${lastDisconnect?.error?.message || ''}). Reconectando…`); pidioCodigo = false; setTimeout(iniciar, 2000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      if (!m.message || !jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
      if (enviados.has(m.key.id)) continue;                    // lo mandó el bot
      if (PERSONAL) {
        // Modo personal: solo el chat "Mensajes para mí" del dueño. A nadie más se le responde.
        const yo = [sock.user?.id, sock.user?.lid].filter(Boolean).map(j => j.split(':')[0].split('@')[0]);
        if (!m.key.fromMe || !yo.includes(jid.split('@')[0])) continue;
      } else if (m.key.fromMe) continue;
      cola = cola.then(() => atender(sock, m)).catch(e => log('error', e.message));
    }
  });
}

async function atender(sock, m) {
  const jid = m.key.remoteJid;
  const msg = m.message;
  const texto = msg.conversation || msg.extendedTextMessage?.text || msg.videoMessage?.caption || '';
  const video = msg.videoMessage;
  // Pedido que armó la página: "🔊 Quiero mi sticker: K7F2"
  const cod = (texto.match(/sticker\W*([A-Z0-9]{4})\b/i) || [])[1]?.toUpperCase();
  if (cod && pedidos.has(cod)) {
    const p = pedidos.get(cod);
    if (p.estado !== 'listo' && p.estado !== 'enviado') { await sock.sendMessage(jid, { text: 'Todavía lo estoy armando, ya te llega ⏳' }); await p.promesa?.catch(() => {}); }
    if (!p.res) { await sock.sendMessage(jid, { text: 'Ese sticker no se pudo armar 😕. Probá de nuevo desde la página.' }); return; }
    await enviarSticker(sock, jid, p.res, m);
    p.estado = 'enviado';
    await avisoGratis(sock, jid);
    log(`→ pedido ${cod} enviado`);
    return;
  }
  const link = (texto.match(/https?:\/\/\S*(x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|tiktok\.com)\S*/i) || [])[0];
  if (!video && !link) { if (!PERSONAL) await sock.sendMessage(jid, { text: AYUDA }); return; }

  await sock.sendMessage(jid, { react: { text: '⏳', key: m.key } });
  const dir = await mkdtemp(join(tmpdir(), 'cts-in-'));
  try {
    const entrada = join(dir, 'in.mp4');
    const datos = video ? await downloadMediaMessage(m, 'buffer', {}) : await bajarVideo(link);
    await writeFile(entrada, datos);
    const opciones = leerOpciones(texto);
    log(`→ ${jid.split('@')[0]}: ${video ? 'video' : link} desde=${opciones.desde} dura=${opciones.dura} audio=${opciones.conAudio}`);
    const res = await convertir(entrada, opciones);
    const conSonido = await enviarSticker(sock, jid, res, m);
    await avisoGratis(sock, jid);
    if (opciones.conAudio && !conSonido) await sock.sendMessage(jid, { text: 'Ese video no tiene sonido, así que va sin audio.' });
    await sock.sendMessage(jid, { react: { text: '✅', key: m.key } });
    log(`  listo (${(res.webp.length / 1024).toFixed(0)} KB${res.ogg ? ' + audio' : ''})`);
  } catch (e) {
    log('  error:', e.message);
    await sock.sendMessage(jid, { text: `No pude hacerlo 😕 (${e.message}). Probá con otro video.` });
    await sock.sendMessage(jid, { react: { text: '❌', key: m.key } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------
// 6) "Puerta" para la página: la página pide el sticker por detrás,
//    el bot lo arma y le da un código. La persona manda el código por
//    WhatsApp (un toque) y el bot le responde con el sticker ya hecho.
//    POST /pedido {link, desde, dura, conAudio}  → {codigo}
//    GET  /pedido/K7F2                            → {estado}
//    GET  /pedido/K7F2/sticker.webp | audio.ogg   → archivos para la vista previa
// ---------------------------------------------------------------------
const pedidos = new Map();
const PUERTO = Number(process.env.PUERTO || 8787);
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevoCodigo() {
  let c; do { c = Array.from({ length: 4 }, () => LETRAS[Math.floor(Math.random() * LETRAS.length)]).join(''); } while (pedidos.has(c));
  return c;
}
setInterval(() => { const lim = Date.now() - 60 * 60 * 1000; for (const [c, p] of pedidos) if (p.creado < lim) pedidos.delete(c); }, 5 * 60 * 1000);

async function armarPedido(p, { link, desde, dura, conAudio }) {
  const dir = await mkdtemp(join(tmpdir(), 'cts-api-'));
  try {
    const f = join(dir, 'in.mp4'); await writeFile(f, await bajarVideo(link));
    p.res = await convertir(f, { desde, dura, conAudio });
    p.estado = 'listo';
    log(`  pedido ${p.codigo} listo (${(p.res.webp.length / 1024).toFixed(0)} KB${p.res.ogg ? ' + audio' : ''})`);
  } catch (e) { p.estado = 'error'; p.error = e.message; log(`  pedido ${p.codigo} error: ${e.message}`); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function iniciarApi() {
  const http = await import('node:http');
  const cors = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true',
  };
  const json = (res, code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/pedido') {
        let body = ''; for await (const ch of req) { body += ch; if (body.length > 10000) return json(res, 413, { error: 'muy grande' }); }
        const d = JSON.parse(body || '{}');
        if (!/^https?:\/\/\S*(x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|tiktok\.com)/i.test(d.link || '')) return json(res, 400, { error: 'Solo links de X o TikTok' });
        const p = { codigo: nuevoCodigo(), estado: 'armando', creado: Date.now() };
        pedidos.set(p.codigo, p);
        log(`→ pedido ${p.codigo} desde la página: ${d.link} desde=${d.desde} dura=${d.dura} audio=${d.conAudio !== false}`);
        p.promesa = armarPedido(p, { link: d.link, desde: +d.desde || 0, dura: Math.min(+d.dura || MAX_SEG, MAX_SEG), conAudio: d.conAudio !== false });
        return json(res, 200, { codigo: p.codigo });
      }
      const m = url.pathname.match(/^\/pedido\/([A-Z0-9]{4})(\/(sticker\.webp|audio\.ogg))?$/);
      if (req.method === 'GET' && m) {
        const p = pedidos.get(m[1]); if (!p) return json(res, 404, { error: 'No existe' });
        if (!m[3]) return json(res, 200, { estado: p.estado, error: p.error, conAudio: !!p.res?.ogg });
        const buf = m[3] === 'sticker.webp' ? p.res?.webp : p.res?.ogg;
        if (!buf) return json(res, 404, { error: 'Todavía no' });
        res.writeHead(200, { ...cors, 'Content-Type': m[3] === 'sticker.webp' ? 'image/webp' : 'audio/ogg', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      if (url.pathname === '/') return json(res, 200, { ok: true, bot: 'Creá tu sticker' });
      json(res, 404, { error: 'No existe' });
    } catch (e) { json(res, 500, { error: e.message }); }
  }).listen(PUERTO, () => log(`🌐 Puerta para la página en http://localhost:${PUERTO}`));
}

// Modo prueba sin WhatsApp:  node bot.mjs --probar <link>
if (process.argv[2] === '--probar') {
  const dir = await mkdtemp(join(tmpdir(), 'cts-p-'));
  const f = join(dir, 'in.mp4'); await writeFile(f, await bajarVideo(process.argv[3]));
  const r = await convertir(f, leerOpciones(process.argv.slice(4).join(' ')));
  await writeFile('prueba.webp', r.webp); if (r.ogg) await writeFile('prueba.ogg', r.ogg);
  const bytes = r.ogg ? armarAudioSticker({ mimetype: 'image/webp', isAnimated: true, width: 512, height: 512, fileLength: r.webp.length }, { mimetype: 'audio/ogg; codecs=opus', seconds: r.segundos }) : null;
  // Chequeo del armado: el mensaje final tiene que ser el campo 134 → 1 → 26 (sticker) con 25 y 26 adentro
  let estructura = null;
  if (bytes) {
    const fin = proto.Message.encode({ stickerMessage: { mimetype: 'image/webp' }, __audioStickerBytes: bytes }).finish();
    const campos = (buf) => { const r = protobuf.Reader.create(buf), out = []; while (r.pos < r.len) { const t = r.uint32(); const n = t >>> 3; if ((t & 7) === 2) { const sub = r.bytes(); out.push([n, sub]); } else { r.skipType(t & 7); out.push([n]); } } return out; };
    const n1 = campos(fin), fp = campos(n1[0][1]), msg = campos(fp[0][1]), st = campos(msg[0][1]);
    estructura = { mensaje: n1.map(c => c[0]), futureProof: fp.map(c => c[0]), message: msg.map(c => c[0]), sticker: st.map(c => c[0]) };
  }
  console.log(JSON.stringify({ estructura, webpKB: +(r.webp.length / 1024).toFixed(1), oggKB: r.ogg ? +(r.ogg.length / 1024).toFixed(1) : 0, segundos: r.segundos, exif: r.webp.includes(Buffer.from('EXIF')), mensajeBytes: bytes?.length }));
  await rm(dir, { recursive: true, force: true });
} else {
  iniciar();
  iniciarApi();
}
