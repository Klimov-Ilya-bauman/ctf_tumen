import { ExecutionContextManager } from "./harness.js";
import { describeResources } from "./schematic.js";
import {
  ResourceDefinition,
  type FrameworkConfig,
  type InnerDefinition,
  type PermissionsContextAccessor,
  type RelationContextAccessor,
  type RoleContextAccessor,
} from "./blueprint.js";
import {
  createContextAccessor,
  QueryContext,
  RoleExpression,
  type Constructor,
  type ContextAccessor,
  type Expression,
  type ObjectLike,
} from "./clockwork.js";
import { Web } from "./chassis.js";

export const USER_ALIAS = "__user";

export type PermissionOperation = "create" | "read" | "update" | "delete";

export type CompiledResource<TResource extends ObjectLike> = {
  name: string;
  resource: Constructor<TResource>;
  definition: ResourceDefinition<any, TResource, any>;
  roles: string[];
  permissions: Partial<Record<PermissionOperation, Expression<boolean>>>;
  grants: Record<string, Expression<boolean>>;
  assigns: { roles: string[]; expression: Expression<string> }[];
  inherits: {
    from: { name: string; class: Constructor<ObjectLike> };
    via: Expression<boolean>;
  }[];
  implies: Record<string, string[]>;
};

type AnyDefinition = ResourceDefinition<any, ObjectLike, any>;

type PendingDefinition = {
  name: string;
  resourceClass: Constructor<ObjectLike>;
  handle: AnyDefinition;
  builder: (definition: any) => AnyDefinition;
};

export class Application<TUserResource extends ObjectLike> {
  private resources = new Map<
    Constructor<ObjectLike>,
    CompiledResource<ObjectLike>
  >();
  private pending: PendingDefinition[] = [];
  private compiled = false;
  private executionContextManager =
    new ExecutionContextManager<TUserResource>();

  readonly web: Web<TUserResource>;

  constructor(private userResource: Constructor<TUserResource>) {
    this.web = new Web(this.executionContextManager);
  }

  define<
    TResource extends ObjectLike,
    TDefinition extends ResourceDefinition<
      FrameworkConfig<TUserResource>,
      TResource,
      InnerDefinition<FrameworkConfig<TUserResource>, TResource> & {
        permissions: {};
      }
    >,
  >(
    name: string,
    resourceClass: Constructor<TResource>,
    builder: (
      definition: ReturnType<
        typeof ResourceDefinition.create<
          FrameworkConfig<TUserResource>,
          TResource
        >
      >,
    ) => TDefinition,
  ): TDefinition {
    if (this.compiled) {
      throw new Error(`Can't define ${name} after compile()`);
    }

    const duplicate = this.pending.find(
      (entry) => entry.name === name || entry.resourceClass === resourceClass,
    );

    if (duplicate) {
      throw new Error(
        `Resource ${name} (${resourceClass.name}) clashes with ${duplicate.name} (${duplicate.resourceClass.name})`,
      );
    }

    const handle = ResourceDefinition.create(
      this.getConfig(),
      resourceClass,
      name,
    );

    this.pending.push({
      name,
      resourceClass,
      handle,
      builder: builder as PendingDefinition["builder"],
    });

    return handle as unknown as TDefinition;
  }

  compile() {
    if (this.compiled) {
      return;
    }

    const byClass = new Map(
      this.pending.map((entry) => [entry.resourceClass, entry]),
    );
    const state = new Map<Constructor<ObjectLike>, "compiling" | "done">();

    const visit = (entry: PendingDefinition, path: string[]) => {
      const current = state.get(entry.resourceClass);

      if (current === "done") {
        return;
      }

      if (current === "compiling") {
        throw new Error(
          `Circular inheritance: ${[...path, entry.name].join(" -> ")}`,
        );
      }

      state.set(entry.resourceClass, "compiling");

      const built = entry.builder(
        ResourceDefinition.create(
          this.getConfig(),
          entry.resourceClass,
          entry.name,
        ),
      );

      if (built.inner.permissions === null) {
        throw new Error(
          `Resource ${entry.name} has no permissions; call .permissions() in its builder`,
        );
      }

      for (const { from } of built.inner.inherit) {
        const parent = byClass.get(from.resource);

        if (!parent) {
          throw new Error(
            `Resource ${entry.name} inherits from ${from.name}, which is not defined`,
          );
        }

        visit(parent, [...path, entry.name]);
      }

      entry.handle.inner = built.inner;
      this.resources.set(entry.resourceClass, this.compileDefinition(built));
      state.set(entry.resourceClass, "done");
    };

    for (const entry of this.pending) {
      visit(entry, []);
    }

    this.compiled = true;
  }

  getExecutionContextManager(): ExecutionContextManager<TUserResource> {
    return this.executionContextManager;
  }

  describe(): string {
    this.requireCompiled();
    return describeResources([...this.resources.values()], this.userResource);
  }

  getCompiledResource<TResource extends ObjectLike>(
    resourceClass: Constructor<TResource>,
  ): CompiledResource<TResource> {
    this.requireCompiled();
    const resource = this.resources.get(resourceClass);

    if (!resource) {
      throw new Error(`Resource ${resourceClass.name} is not registered`);
    }

    return resource as CompiledResource<TResource>;
  }

  private requireCompiled() {
    if (!this.compiled) {
      throw new Error("Application.compile() hasn't been called yet");
    }
  }

  private compileDefinition<TResource extends ObjectLike>(
    definition: ResourceDefinition<
      FrameworkConfig<TUserResource>,
      TResource,
      any
    >,
  ): CompiledResource<TResource> {
    const inner: InnerDefinition<
      FrameworkConfig<TUserResource>,
      TResource
    > = definition.inner;

    const grants = Object.fromEntries(
      Object.entries(inner.grant).map(([role, predicate]) => [
        role,
        predicate(this.createRoleContext(definition)),
      ]),
    );

    const assigns = inner.assign.map(({ roles, producer }) => ({
      roles,
      expression: producer(this.createRoleContext(definition)),
    }));

    const inherits = inner.inherit.map(({ from, via }) => ({
      from: {
        name: from.name,
        class: from.resource,
      },
      via: via(this.createRelationContext(definition, from)),
    }));

    const roles = new Set<string>([
      ...Object.keys(inner.grant),
      ...inner.assign.flatMap(({ roles }) => roles),
      ...Object.keys(inner.implies),
      ...Object.values(inner.implies).flat(),
    ]);

    for (const { from } of inner.inherit) {
      const parent = this.resources.get(from.resource);

      if (!parent) {
        throw new Error(
          `Resource ${definition.name} inherits from ${from.name}, which is not registered`,
        );
      }

      parent.roles.forEach((role) => roles.add(role));
    }

    const permissionsContext = this.createPermissionsContext(definition, roles);

    const permissions = Object.fromEntries(
      Object.entries(inner.permissions ?? {}).flatMap(
        ([operation, producer]) =>
          producer ? [[operation, producer(permissionsContext)]] : [],
      ),
    );

    return {
      name: definition.name,
      resource: definition.resource,
      definition,
      roles: [...roles],
      permissions,
      grants,
      assigns,
      inherits,
      implies: inner.implies,
    };
  }

  private createRoleContext<TResource extends ObjectLike>(
    definition: ResourceDefinition<
      FrameworkConfig<TUserResource>,
      TResource,
      any
    >,
  ): RoleContextAccessor<TResource, FrameworkConfig<TUserResource>> {
    const queryContext = new QueryContext();
    const user = this.createUserAccessor(queryContext);

    return {
      ...createContextAccessor(
        definition.resource,
        definition.name,
        queryContext,
      ),
      user,
    };
  }

  private createRelationContext<
    TLeft extends ObjectLike,
    TRight extends ObjectLike,
  >(
    left: ResourceDefinition<FrameworkConfig<TUserResource>, TLeft, any>,
    right: ResourceDefinition<FrameworkConfig<TUserResource>, TRight, any>,
  ): RelationContextAccessor<TLeft, TRight, FrameworkConfig<TUserResource>> {
    const queryContext = new QueryContext();
    const user = this.createUserAccessor(queryContext);

    return {
      left: createContextAccessor(left.resource, left.name, queryContext),
      right: createContextAccessor(right.resource, right.name, queryContext),
      user,
    };
  }

  private createPermissionsContext<
    TResource extends ObjectLike,
    TRoles extends string,
  >(
    definition: ResourceDefinition<
      FrameworkConfig<TUserResource>,
      TResource,
      any
    >,
    roles: Set<TRoles>,
  ): PermissionsContextAccessor<
    TResource,
    TRoles,
    FrameworkConfig<TUserResource>
  > {
    const queryContext = new QueryContext();
    const user = this.createUserAccessor(queryContext);

    const rolesAccessor = Object.fromEntries(
      [...roles].map((role) => [
        role,
        new RoleExpression<"access">(queryContext, role),
      ]),
    );

    return {
      ...createContextAccessor(
        definition.resource,
        definition.name,
        queryContext,
      ),
      roles: rolesAccessor as Record<TRoles, RoleExpression<"access">>,
      user,
    };
  }

  private createUserAccessor(
    queryContext: QueryContext,
  ): ContextAccessor<TUserResource> {
    return createContextAccessor(this.userResource, USER_ALIAS, queryContext);
  }

  private getConfig(): FrameworkConfig<TUserResource> {
    return {
      userResourceConstructor: this.userResource,
      __userResource: undefined as unknown as TUserResource,
    };
  }
}
