const { createClient } = require('@supabase/supabase-js')
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const TABLE = 'whatsapp_session'
const KEY = 'auth_state'

async function useSupabaseAuthState() {
  async function readData(id) {
    const { data } = await supabase
      .from(TABLE).select('value').eq('key', id).single()
    if (!data) return null
    return JSON.parse(data.value, BufferJSON.reviver)
  }

  async function writeData(id, value) {
    const json = JSON.stringify(value, BufferJSON.replacer)
    await supabase.from(TABLE)
      .upsert({ key: id, value: json }, { onConflict: 'key' })
  }

  async function removeData(id) {
    await supabase.from(TABLE).delete().eq('key', id)
  }

  const creds = await readData(KEY) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            let val = await readData(`${type}-${id}`)
            if (type === 'app-state-sync-key' && val)
              val = proto.Message.AppStateSyncKeyData.fromObject(val)
            data[id] = val
          }
          return data
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const val = data[category][id]
              if (val) await writeData(`${category}-${id}`, val)
              else await removeData(`${category}-${id}`)
            }
          }
        }
      }
    },
    saveCreds: () => writeData(KEY, creds)
  }
}

module.exports = { useSupabaseAuthState }
