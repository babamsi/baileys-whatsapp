const makeWASocket = require('@whiskeysockets/baileys').default
const { DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys')
const { useSupabaseAuthState } = require('./supabase')
const express = require('express')
const axios = require('axios')
const FormData = require('form-data')

const app = express()
app.use(express.json())

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const SUPABASE_URL = 'https://rdbdiqghqdpqphdjpnwf.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

let sock = null
const lastMsgKey = new Map()
const sentContactCard = new Set() // track who already got the vCard

// ── ElevenLabs STT ────────────────────────────────────────────────────────────
async function transcribeAudio(buffer, mimeType) {
  const form = new FormData()
  form.append('file', buffer, { filename: 'voice.ogg', contentType: mimeType || 'audio/ogg' })
  form.append('model_id', 'scribe_v2')
  const res = await axios.post(
    'https://api.elevenlabs.io/v1/speech-to-text',
    form,
    { headers: { 'xi-api-key': ELEVENLABS_API_KEY, ...form.getHeaders() }, timeout: 20000 }
  )
  return res.data.text || ''
}

// ── Reverse geocode lat/lng → human address ───────────────────────────────────
async function reverseGeocode(lat, lng) {
  try {
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'User-Agent': 'OrangeDesserts/1.0' }, timeout: 6000 }
    )
    const a = res.data.address || {}
    const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.village || ''
    const city = a.city || a.county || 'Nairobi'
    const road = a.road || ''
    const parts = [road, area, city].filter(Boolean)
    return parts.join(', ')
  } catch (e) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  }
}

// ── Upload image to Supabase storage ─────────────────────────────────────────
async function uploadImageToSupabase(buffer, mimeType, filename) {
  try {
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
    const path = `complaints/${Date.now()}_${filename || 'photo'}.${ext}`
    await axios.post(
      `${SUPABASE_URL}/storage/v1/object/complaint-photos/${path}`,
      buffer,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': mimeType,
          'x-upsert': 'true'
        },
        timeout: 15000
      }
    )
    return `${SUPABASE_URL}/storage/v1/object/public/complaint-photos/${path}`
  } catch (e) {
    console.error('❌ Image upload failed:', e.message)
    return null
  }
}

// ── Send contact card ─────────────────────────────────────────────────────────
async function sendContactCard(to) {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Orange Desserts',
    'ORG:Orange Desserts;',
    'TEL;type=CELL;type=VOICE;waid=254757588666:+254757588666',
    'END:VCARD'
  ].join('\n')
  await sock.sendMessage(to, {
    contacts: {
      displayName: 'Orange Desserts',
      contacts: [{ vcard }]
    }
  })
  console.log(`📇 Sent contact card to ${to}`)
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: require('pino')({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('📱 Scan the QR code above with your WhatsApp')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log('Connection closed, code:', code, '| Reconnecting:', shouldReconnect)
      if (shouldReconnect) setTimeout(connectToWhatsApp, 3000)
      else console.log('❌ Logged out. Please redeploy and scan QR again.')
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const from = msg.key.remoteJid
      if (from.endsWith('@g.us')) continue

      // ── Read receipt (blue ticks) ─────────────────────────────────────────
      await sock.readMessages([msg.key])

      lastMsgKey.set(from, msg.key)

      // ── Contact card on first message ─────────────────────────────────────
      if (!sentContactCard.has(from)) {
        sentContactCard.add(from)
        try { await sendContactCard(from) } catch (e) { /* non-critical */ }
      }

      let text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || ''

      let isVoice = false
      let isLocation = false
      let locationData = null
      let imageUrl = null

      // ── Image message → upload to Supabase ───────────────────────────────
      if (msg.message.imageMessage) {
        try {
          console.log(`📸 Image from ${from} — downloading...`)
          const buffer = await downloadMediaMessage(
            msg, 'buffer', {},
            { logger: require('pino')({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
          )
          const mime = msg.message.imageMessage.mimetype || 'image/jpeg'
          imageUrl = await uploadImageToSupabase(buffer, mime, from.split('@')[0])
          if (imageUrl) console.log(`📸 Uploaded: ${imageUrl}`)
        } catch (err) {
          console.error('❌ Image download failed:', err.message)
        }
      }

      // ── Voice note → ElevenLabs STT ──────────────────────────────────────
      if (!text && (msg.message.audioMessage || msg.message.pttMessage)) {
        isVoice = true
        if (!ELEVENLABS_API_KEY) {
          console.warn('⚠️ ELEVENLABS_API_KEY not set — skipping voice transcription')
          continue
        }
        try {
          console.log(`🎤 Voice note from ${from} — downloading...`)
          const buffer = await downloadMediaMessage(
            msg, 'buffer', {},
            { logger: require('pino')({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
          )
          console.log(`🔊 Transcribing ${Math.round(buffer.length / 1024)}KB audio...`)
          text = await transcribeAudio(buffer, 'audio/ogg')
          if (!text) { console.log('⚠️ Empty transcript — skipping'); continue }
          console.log(`📝 Transcript: "${text}"`)
        } catch (err) {
          console.error('❌ Voice transcription failed:', err.message)
          continue
        }
      }

      // ── Location pin → reverse geocode ───────────────────────────────────
      if (!text && msg.message.locationMessage) {
        isLocation = true
        const loc = msg.message.locationMessage
        const lat = loc.degreesLatitude
        const lng = loc.degreesLongitude
        console.log(`📍 Location pin from ${from}: ${lat}, ${lng}`)
        const address = await reverseGeocode(lat, lng)
        text = `📍 ${address}`
        locationData = { lat, lng, address }
        console.log(`📍 Resolved: "${address}"`)
      }

      // if image with no caption, send placeholder text so agent knows
      if (!text && imageUrl) text = '[Customer sent a photo]'

      if (!text) continue

      console.log(`📨 From ${from}: ${text}`)
      try {
        await sock.sendPresenceUpdate('composing', from)
        await axios.post(N8N_WEBHOOK_URL, {
          from,
          message: text,
          timestamp: msg.messageTimestamp,
          messageId: msg.key.id,
          pushName: msg.pushName || '',
          isVoice,
          isLocation,
          hasImage: !!imageUrl,
          imageUrl: imageUrl || null,
          ...(locationData && { location: locationData })
        })
        await sock.sendPresenceUpdate('paused', from)
        console.log(`✅ Forwarded to n8n`)
      } catch (err) {
        await sock.sendPresenceUpdate('paused', from)
        console.error('❌ n8n forward failed:', err.message)
      }
    }
  })
}

// ── Send reply (called by n8n) ────────────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' })
  if (!sock) return res.status(503).json({ error: 'WhatsApp not connected yet' })
  try {
    await sock.sendMessage(to, { text: message })
    console.log(`📤 Sent to ${to}: ${message.substring(0, 60)}`)
    res.json({ success: true })
  } catch (err) {
    console.error('❌ Send failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Order status push notification ───────────────────────────────────────────
app.post('/notify', async (req, res) => {
  const { whatsapp_id, status } = req.body
  if (!whatsapp_id || !status) return res.status(400).json({ error: 'Missing whatsapp_id or status' })
  if (!sock) return res.status(503).json({ error: 'WhatsApp not connected yet' })

  const STATUS_MESSAGES = {
    preparing:  '🔥 Your order is being prepared! Sit tight.',
    on_the_way: '🛵 Your order is on the way! Should be with you in 20-30 mins.',
    delivered:  '✅ Your order has been delivered! Enjoy 😊 Feel free to rate us once you\'re done.',
    cancelled:  '❌ Your order has been cancelled. Call us at 0757588666 for help.'
  }

  const message = STATUS_MESSAGES[status]
  if (!message) return res.status(400).json({ error: `Unknown status: ${status}` })

  try {
    await sock.sendMessage(whatsapp_id, { text: message })
    console.log(`📣 Status notification sent to ${whatsapp_id}: ${status}`)
    res.json({ success: true, status, whatsapp_id })
  } catch (err) {
    console.error('❌ Notify failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── React to customer message ─────────────────────────────────────────────────
app.post('/react', async (req, res) => {
  const { to, messageId, emoji = '✅' } = req.body
  if (!to || !messageId) return res.status(400).json({ error: 'Missing to or messageId' })
  if (!sock) return res.status(503).json({ error: 'WhatsApp not connected' })
  try {
    const key = lastMsgKey.get(to) || { remoteJid: to, id: messageId, fromMe: false }
    await sock.sendMessage(to, { react: { text: emoji, key } })
    console.log(`👍 Reacted ${emoji} to ${to}`)
    res.json({ success: true })
  } catch (err) {
    console.error('❌ React failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    whatsapp: sock ? 'connected' : 'disconnected',
    elevenlabs: ELEVENLABS_API_KEY ? 'configured' : 'missing'
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`)
  console.log(`📡 n8n webhook: ${N8N_WEBHOOK_URL}`)
  console.log(`🎤 ElevenLabs STT: ${ELEVENLABS_API_KEY ? 'enabled' : 'disabled'}`)
  console.log('📍 Location sharing: enabled (Nominatim)')
  console.log('📣 Status notifications: enabled (/notify)')
  console.log('👍 Reactions: enabled (/react)')
  console.log('📇 Contact card: enabled (first message)')
  console.log('👁️  Read receipts: enabled')
  console.log('📸 Image upload: enabled (Supabase)')
})

connectToWhatsApp()
