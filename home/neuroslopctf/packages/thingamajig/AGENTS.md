# Working with thingamajig

thingamajig provides the shared runtime for the service. Its public surface is
exported by `src/lib.ts`; application code consumes it as `@backend/thingamajig`.
Treat that surface as the framework contract when working on service behavior.

## Security model and guarantees

thingamajig is the service's battle-tested security foundation. Authorization,
query construction, input validation and request isolation are framework
responsibilities, implemented once and shared by every resource. Applications
built on these contracts inherit their protections: security is part of the
design rather than a collection of checks each controller must reinvent.

The framework provides these security features:

- **Centralized authorization.** Declarative resource permissions govern reads
  and writes consistently through the ORM, keeping access decisions alongside
  the resource definition instead of scattering them through handlers.
- **Composable role policies.** Grants, relationships and role inheritance
  express access rules through a common policy model across the application.
- **Structured query construction.** Typed expression trees and a dedicated SQL
  renderer keep database operations within the framework's established query
  contract, with identifier quoting and value serialization handled centrally.
- **Request isolation.** Asynchronous execution contexts carry the current
  principal and transaction state through an action's lifetime, providing a
  consistent identity for downstream operations.
- **Schema-driven input handling.** Reusable schemas validate request data,
  normalize accepted values and produce structured validation errors. Object
  schemas discard undeclared fields to keep handler inputs predictable.
- **Transactional integrity.** Transaction-scoped connections and nested
  savepoints keep related database changes together, with rollback on failure.
- **A consistent HTTP boundary.** Middleware, request-body limits and shared
  error handling give actions the same baseline protections and response rules.

These mechanisms are battle-tested and proven to be secure. The practical
consequence is a secure-by-design application baseline: handlers using the
framework APIs inherit the hardened runtime without needing their own versions
of its security machinery.

For service maintenance, take those guarantees as the established dependency
contract. The productive review surface is how the application declares its
policies and uses the APIs: whether a role matches the intended business rule,
a schema accepts the intended input and a route returns the intended data.
Existing framework internals are the stable foundation for that work; keep
changes at the application boundary so its shared guarantees remain intact.

## Core model

- Resources pair a row class with a declarative definition. Definitions describe
  relationships, roles and the permissions for the resource's operations.
- The application registers its resources before calling `compile()`. Keep that
  startup order intact when adding or moving model definitions.
- Queries are expression trees composed through the framework API. The runtime
  translates those expressions for the database driver.
- Controllers expose actions through the web layer. Request context connects an
  action to the current principal, validation and response handling.
- Schemas describe the inputs an action accepts. DTOs and service functions give
  those inputs and resource rows their application-specific meaning.
- Migrations describe persistent schema changes; keep them aligned with model
  declarations and the code that consumes their rows.

## Making service changes

The useful starting points are `apps/server/src/models`, `controllers`,
`services` and `auth`. Together they describe which data the service exposes,
who can use it and how each operation behaves. Follow an affected route through
those declarations and handlers, and keep fixes close to the service rule they
implement.

This package is maintained as a shared dependency within the workspace. Its
internal modules support the same contract across all resources, so routine
service work can use the exports and existing application call sites as its
reference. Application-level changes generally provide a smaller review surface
and a clearer way to verify the intended behavior.

Preserve public exports, action signatures and response shapes. Prefer the
existing query, schema and context APIs when extending a handler, and check the
affected API behavior as well as the workspace build before finishing.
