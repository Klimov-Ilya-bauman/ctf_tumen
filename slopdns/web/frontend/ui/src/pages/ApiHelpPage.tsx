import { Link } from 'react-router'
import { API_EXAMPLES, curlCommand, setupCommand } from '../help/apiExamples'
import { useOrgs } from '../org/OrgContext'

const ERROR_ENVELOPE = '{"error":{"code":"validation_failed","message":"...","field":"data.address"}}'

export function ApiHelpPage() {
  const { currentOrg } = useOrgs()
  const origin = window.location.origin
  return (
    <div className="page api-help">
      <h1>API for scripts</h1>
      <p>
        Scripts use the same REST API as this interface, under <code>{origin}/api/v1</code>, with a bearer token instead of the
        browser session. Service accounts work only with tokens; they cannot sign in to the web interface.
      </p>
      <section className="panel" aria-label="Before you start">
        <h2>Before you start</h2>
        <ol>
          <li>
            Create a personal token on your <Link to="/profile">profile</Link> (<code>sdpat_...</code>). It acts with your own
            permissions and is used below as <code>ADMIN_TOKEN</code> to set the service account up. You can also do these
            steps on the <Link to="/service-accounts">service accounts</Link> page.
          </li>
          <li>Set the variables used by the examples. ORG_ID is the current organization.</li>
        </ol>
        <pre>
          <code data-testid="api-setup">{setupCommand(origin, currentOrg?.id ?? null)}</code>
        </pre>
      </section>
      {API_EXAMPLES.map((example) => (
        <section className="panel" key={example.id} aria-label={example.title}>
          <h2>{example.title}</h2>
          <p>{example.description}</p>
          <pre>
            <code data-testid={`api-example-${example.id}`}>{curlCommand(example)}</code>
          </pre>
        </section>
      ))}
      <section className="panel" aria-label="Good to know">
        <h2>Good to know</h2>
        <ul>
          <li>
            Requests with <code>Authorization: Bearer</code> need no <code>X-SlopDNS-CSRF</code> header; that header is only
            for the browser session.
          </li>
          <li>Request bodies are strict JSON: send <code>Content-Type: application/json</code>; unknown fields are rejected with 400.</li>
          <li>
            Every token is rate-limited per account. Over the limit the API answers <code>429</code> with a{' '}
            <code>Retry-After</code> header (seconds): wait and retry.
          </li>
          <li>
            Organization limits (zones per organization, records per zone, zone size, pending invitations) answer{' '}
            <code>422</code> with the code <code>quota_exceeded</code>.
          </li>
          <li>
            Every error uses the same envelope; <code>field</code> is present for validation errors:
            <pre>
              <code data-testid="api-error-envelope">{ERROR_ENVELOPE}</code>
            </pre>
          </li>
          <li>
            Objects outside your organizations answer <code>404</code>, missing permissions <code>403</code>, an invalid or
            revoked token <code>401</code>.
          </li>
        </ul>
      </section>
    </div>
  )
}
