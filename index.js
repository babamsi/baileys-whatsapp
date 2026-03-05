const makeWASocket = require('@whiskeysockets/baileys').default
const { DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { useSupabaseAuthState } = require('./supabase')
const express = require('express')
const axios = require('axios')

const app = express()
app.use(express.json())

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL
let sock = null

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
    if (qr) {
      console.log('📱 Scan the QR code above with your WhatsApp')
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log('Connection closed, code:', code, '| Reconnecting:', shouldReconnect)
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000)
      } else {
        console.log('❌ Logged out. Please redeploy and scan QR again.')
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const from = msg.key.remoteJid
      // Skip group messages
      if (from.endsWith('@g.us')) continue

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ''

      if (!text) continue

      console.log(`📨 From ${from}: ${text}`)

      try {
        await axios.post(N8N_WEBHOOK_URL, {
          from,
          message: text,
          timestamp: msg.messageTimestamp,
          messageId: msg.key.id,
          pushName: msg.pushName || ''
        })
        console.log(`✅ Forwarded to n8n`)
      } catch (err) {
        console.error('❌ n8n forward failed:', err.message)
      }
    }
  })
}

// n8n calls this to send a reply back to customer
app.post('/send', async (req, res) => {
  const { to, message } = req.body

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing to or message' })
  }
  if (!sock) {
    return res.status(503).json({ error: 'WhatsApp not connected yet' })
  }

  try {
    await sock.sendMessage(to, { text: message })
    console.log(`📤 Sent to ${to}: ${message}`)
    res.json({ success: true })
  } catch (err) {
    console.error('❌ Send failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Health check
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    whatsapp: sock ? 'connected' : 'disconnected'
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`)
  console.log(`📡 n8n webhook: ${N8N_WEBHOOK_URL}`)
})

connectToWhatsApp()
