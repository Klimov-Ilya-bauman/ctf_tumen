export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface ApiExample {
  id: string
  title: string
  description: string
  method: HttpMethod
  path: string
  query?: string
  token: 'ADMIN_TOKEN' | 'SA_TOKEN'
  requestSchema?: string
  body?: string
  expectedStatus: number
}

export const EXAMPLE_VARIABLES = ['ORG_ID', 'SA_ID', 'ZONE_ID', 'RECORD_ID', 'TOKEN_ID'] as const
export type ExampleVariable = (typeof EXAMPLE_VARIABLES)[number]

export const API_EXAMPLES: ApiExample[] = [
  {
    id: 'create-service-account',
    title: 'Create a service account',
    description: 'Run as a user with editor or higher on the organization. The response contains the account id: put it into SA_ID.',
    method: 'POST',
    path: '/api/v1/service-accounts',
    token: 'ADMIN_TOKEN',
    requestSchema: 'ServiceAccountCreate',
    body: '{"org_id":"@ORG_ID@","name":"deploy-bot","description":"CI deployments"}',
    expectedStatus: 201,
  },
  {
    id: 'grant-org-role',
    title: 'Grant it a role on the organization',
    description: 'Requires admin on the organization. editor lets the account create zones and change records in every zone of the organization.',
    method: 'POST',
    path: '/api/v1/role-bindings',
    token: 'ADMIN_TOKEN',
    requestSchema: 'RoleBindingCreate',
    body: '{"principal_type":"service_account","principal_id":"@SA_ID@","resource_type":"org","resource_id":"@ORG_ID@","role":"editor"}',
    expectedStatus: 201,
  },
  {
    id: 'grant-zone-role',
    title: 'Or grant it a role on a single zone',
    description: 'Requires admin on the zone. The account then sees and edits only this zone.',
    method: 'POST',
    path: '/api/v1/role-bindings',
    token: 'ADMIN_TOKEN',
    requestSchema: 'RoleBindingCreate',
    body: '{"principal_type":"service_account","principal_id":"@SA_ID@","resource_type":"zone","resource_id":"@ZONE_ID@","role":"editor"}',
    expectedStatus: 201,
  },
  {
    id: 'issue-token',
    title: 'Issue a static token',
    description: 'Requires admin on the service account. The token field (sdsat_...) is shown only in this response: store it as SA_TOKEN. Service account tokens never expire until revoked.',
    method: 'POST',
    path: '/api/v1/service-accounts/$SA_ID/tokens',
    token: 'ADMIN_TOKEN',
    requestSchema: 'ServiceAccountTokenCreate',
    body: '{"name":"ci"}',
    expectedStatus: 201,
  },
  {
    id: 'who-am-i',
    title: 'Check the token',
    description: 'Returns the service account and its organization.',
    method: 'GET',
    path: '/api/v1/auth/me',
    token: 'SA_TOKEN',
    expectedStatus: 200,
  },
  {
    id: 'list-zones',
    title: 'List zones',
    description: 'Only zones the account has a role on (directly or through the organization) are returned.',
    method: 'GET',
    path: '/api/v1/zones',
    query: 'org_id=$ORG_ID',
    token: 'SA_TOKEN',
    expectedStatus: 200,
  },
  {
    id: 'create-zone',
    title: 'Create a zone under .slop',
    description: 'Requires editor on the organization. The response contains the zone id: put it into ZONE_ID.',
    method: 'POST',
    path: '/api/v1/zones',
    token: 'SA_TOKEN',
    requestSchema: 'ZoneCreate',
    body: '{"org_id":"@ORG_ID@","name":"deploy.slop"}',
    expectedStatus: 201,
  },
  {
    id: 'create-a-record',
    title: 'Create an A record',
    description: 'name is relative to the zone (@ is the apex). ttl is optional and defaults to the zone default. The response contains the record id: put it into RECORD_ID.',
    method: 'POST',
    path: '/api/v1/zones/$ZONE_ID/records',
    token: 'SA_TOKEN',
    requestSchema: 'RecordInput',
    body: '{"name":"www","type":"A","ttl":300,"data":{"address":"192.0.2.10"}}',
    expectedStatus: 201,
  },
  {
    id: 'create-gpt-record',
    title: 'Create a GPT record',
    description: 'GPT carries up to 40 bytes of UTF-8 text.',
    method: 'POST',
    path: '/api/v1/zones/$ZONE_ID/records',
    token: 'SA_TOKEN',
    requestSchema: 'RecordInput',
    body: '{"name":"flag","type":"GPT","data":{"text":"hello from slopdns"}}',
    expectedStatus: 201,
  },
  {
    id: 'update-record',
    title: 'Update a record',
    description: 'PUT replaces the whole record, including name and type.',
    method: 'PUT',
    path: '/api/v1/records/$RECORD_ID',
    token: 'SA_TOKEN',
    requestSchema: 'RecordInput',
    body: '{"name":"www","type":"A","ttl":600,"data":{"address":"192.0.2.20"}}',
    expectedStatus: 200,
  },
  {
    id: 'delete-record',
    title: 'Delete a record',
    description: 'Returns 204 No Content.',
    method: 'DELETE',
    path: '/api/v1/records/$RECORD_ID',
    token: 'SA_TOKEN',
    expectedStatus: 204,
  },
  {
    id: 'list-tokens',
    title: 'List the account tokens',
    description: 'Requires admin on the service account. Secrets are never returned again; use the id to revoke.',
    method: 'GET',
    path: '/api/v1/service-accounts/$SA_ID/tokens',
    token: 'ADMIN_TOKEN',
    expectedStatus: 200,
  },
  {
    id: 'revoke-token',
    title: 'Revoke a token',
    description: 'Requires admin on the service account. The token stops working on the next request.',
    method: 'DELETE',
    path: '/api/v1/service-accounts/$SA_ID/tokens/$TOKEN_ID',
    token: 'ADMIN_TOKEN',
    expectedStatus: 204,
  },
]

function shellBody(body: string): string {
  return `'${body.replace(/@([A-Z_]+)@/g, `'"$$$1"'`)}'`
}

export function curlCommand(example: ApiExample): string {
  const url = `"$BASE${example.path}${example.query ? `?${example.query}` : ''}"`
  const lines = [`curl -sS -X ${example.method} ${url}`, `  -H "Authorization: Bearer $${example.token}"`]
  if (example.body !== undefined) {
    lines.push(`  -H 'Content-Type: application/json'`)
    lines.push(`  -d ${shellBody(example.body)}`)
  }
  return lines.join(' \\\n')
}

export function setupCommand(origin: string, orgId: string | null): string {
  return [
    `BASE=${origin}`,
    'ADMIN_TOKEN=sdpat_...',
    `ORG_ID=${orgId ?? '...'}`,
    'SA_ID=...',
    'SA_TOKEN=sdsat_...',
    'ZONE_ID=...',
    'RECORD_ID=...',
    'TOKEN_ID=...',
  ].join('\n')
}
