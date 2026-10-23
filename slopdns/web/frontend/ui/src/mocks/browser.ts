import { setupWorker } from 'msw/browser'
import { MOCK_PASSWORD, MockDb } from './db'
import { createHandlers } from './handlers'
import { permissiveValidator } from './contract'

export async function startBrowserMocks(): Promise<void> {
  const db = new MockDb()
  const demo = db.addUser('demo')
  const org = db.defaultOrgOf(demo)
  const zone = db.addZone(org.id, 'demo.slop')
  db.addRecord(zone.id, { name: `www.${zone.name}`, type: 'A', data: { address: '192.0.2.10' } })
  db.addRecord(zone.id, { name: `flag.${zone.name}`, type: 'GPT', data: { text: 'hello from slopdns' } })
  const friend = db.addUser('friend')
  db.addInvitation(db.defaultOrgOf(friend).id, demo.id, friend.id, 'editor')
  const worker = setupWorker(...createHandlers(db, permissiveValidator))
  await worker.start({ onUnhandledRequest: 'bypass' })
  console.info(`SlopDNS mock API is active. Sign in as demo / ${MOCK_PASSWORD}`)
}
