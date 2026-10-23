import {
  RoleExpression,
  type Constructor,
  type ContextAccessor,
  type Expression,
  type ObjectLike,
} from "./clockwork.js";

export type FrameworkConfig<TUserResource extends ObjectLike = ObjectLike> = {
  __userResource: TUserResource;
  userResourceConstructor: Constructor<TUserResource>;
};

export type RoleContextAccessor<
  TResource extends ObjectLike,
  TConfig extends FrameworkConfig,
> = ContextAccessor<TResource> & {
  user: ContextAccessor<TConfig["__userResource"]>;
};

export type PermissionsContextAccessor<
  TResource extends ObjectLike,
  TRoles extends string,
  TConfig extends FrameworkConfig,
> = ContextAccessor<TResource> & {
  roles: {
    [K in TRoles]: RoleExpression<"access">;
  };
  user: ContextAccessor<TConfig["__userResource"]>;
};

export type RelationContextAccessor<
  TLeft extends ObjectLike,
  TRight extends ObjectLike,
  TConfig extends FrameworkConfig,
> = {
  left: ContextAccessor<TLeft>;
  right: ContextAccessor<TRight>;
  user: ContextAccessor<TConfig["__userResource"]>;
};

type ResourceOptions<
  TResource extends ObjectLike,
  TConfig extends FrameworkConfig,
> = {
  name: string;
  inherit: [
    {
      from: Constructor<ObjectLike>;
      via: (
        ctx: RoleContextAccessor<TResource, TConfig>,
      ) => Expression<boolean>;
    },
  ];
  grant: Record<
    string,
    (ctx: RoleContextAccessor<TResource, TConfig>) => Expression<boolean>
  >;
  assign: ((
    ctx: RoleContextAccessor<TResource, TConfig>,
  ) => Expression<string>)[];
  implies: Record<string, string[]>[];
  permissions: {
    create: (
      ctx: RoleContextAccessor<TResource, TConfig>,
    ) => Expression<boolean>;
    read: (ctx: RoleContextAccessor<TResource, TConfig>) => Expression<boolean>;
    update: (
      ctx: RoleContextAccessor<TResource, TConfig>,
    ) => Expression<boolean>;
    delete: (
      ctx: RoleContextAccessor<TResource, TConfig>,
    ) => Expression<boolean>;
  };
};

type ResourcePermissions<
  TResource extends ObjectLike,
  TRoles extends string,
  TConfig extends FrameworkConfig,
> = {
  create: (
    ctx: PermissionsContextAccessor<TResource, TRoles, TConfig>,
  ) => Expression<boolean>;
  read: (
    ctx: PermissionsContextAccessor<TResource, TRoles, TConfig>,
  ) => Expression<boolean>;
  update: (
    ctx: PermissionsContextAccessor<TResource, TRoles, TConfig>,
  ) => Expression<boolean>;
  delete: (
    ctx: PermissionsContextAccessor<TResource, TRoles, TConfig>,
  ) => Expression<boolean>;
};

export type Resource<TRow extends ObjectLike> = ResourceDefinition<
  any,
  TRow,
  any
>;

export type InnerDefinition<
  TConfig extends FrameworkConfig,
  TResource extends ObjectLike,
> = {
  __roles: string;
  inherit: {
    from: ResourceDefinition<TConfig, ObjectLike, any>;
    via: (
      ctx: RelationContextAccessor<TResource, any, TConfig>,
    ) => Expression<boolean>;
  }[];
  grant: Record<
    string,
    (ctx: RoleContextAccessor<TResource, TConfig>) => Expression<boolean>
  >;
  assign: {
    roles: string[];
    producer: (
      ctx: RoleContextAccessor<TResource, TConfig>,
    ) => Expression<string>;
  }[];
  implies: Record<string, string[]>;
  permissions: Partial<ResourcePermissions<TResource, string, TConfig>> | null;
};

export class ResourceDefinition<
  TConfig extends FrameworkConfig,
  TResource extends ObjectLike,
  TInner extends InnerDefinition<TConfig, TResource>,
> {
  constructor(
    public config: TConfig,
    public resource: Constructor<TResource>,
    public readonly name: string,
    public inner: TInner,
  ) {}

  inherit<
    TFromResource extends ObjectLike,
    TFromInner extends InnerDefinition<TConfig, TFromResource>,
  >(
    from: ResourceDefinition<TConfig, TFromResource, TFromInner>,
    via: (
      ctx: RelationContextAccessor<TResource, TFromResource, TConfig>,
    ) => Expression<boolean>,
  ) {
    return new ResourceDefinition(this.config, this.resource, this.name, {
      ...this.inner,
      inherit: [...this.inner.inherit, { from, via }],
    } as Omit<TInner, "__roles" | "inherit"> & {
      __roles: TInner["__roles"] | TFromInner["__roles"];
      inherit: {
        from: ResourceDefinition<TConfig, ObjectLike, any>;
        via: typeof via;
      }[];
    });
  }

  assign<TRoles extends string>(
    roles: TRoles[],
    producer: (
      ctx: RoleContextAccessor<TResource, TConfig>,
    ) => Expression<NoInfer<TRoles>>,
  ) {
    return new ResourceDefinition(this.config, this.resource, this.name, {
      ...this.inner,
      assign: [...this.inner.assign, { roles, producer }],
    } as Omit<TInner, "__roles" | "assign"> & {
      __roles: TInner["__roles"] | TRoles;
      assign: InnerDefinition<TConfig, TResource>["assign"];
    });
  }

  grant<TRole extends string>(
    role: TRole,
    predicate: (
      ctx: RoleContextAccessor<TResource, TConfig>,
    ) => Expression<boolean>,
  ) {
    return new ResourceDefinition(this.config, this.resource, this.name, {
      ...this.inner,
      grant: {
        ...this.inner.grant,
        [role]: predicate,
      },
    } as Omit<TInner, "__roles" | "grant"> & {
      __roles: TInner["__roles"] | TRole;
      grant: TInner["grant"] & Record<TRole, typeof predicate>;
    });
  }

  implies<TRole extends TInner["__roles"], TImplied extends string>(
    role: TRole,
    implied: TImplied[],
  ) {
    return new ResourceDefinition(this.config, this.resource, this.name, {
      ...this.inner,
      implies: {
        ...this.inner.implies,
        [role]: [...(this.inner.implies[role] ?? []), ...implied],
      },
    } as Omit<TInner, "__roles" | "implies"> & {
      __roles: TInner["__roles"] | TImplied;
      implies: Record<string, string[]>;
    });
  }

  permissions(
    this: ResourceDefinition<
      TConfig,
      TResource,
      {
        __roles: any;
        inherit: any;
        grant: any;
        assign: any;
        implies: any;
        permissions: null;
      }
    >,
    permissions: Partial<
      ResourcePermissions<TResource, TInner["__roles"], TConfig>
    >,
  ) {
    return new ResourceDefinition(this.config, this.resource, this.name, {
      ...this.inner,
      permissions,
    } as Omit<TInner, "permissions"> & {
      permissions: Partial<
        ResourcePermissions<TResource, TInner["__roles"], TConfig>
      >;
    });
  }

  build(
    this: ResourceDefinition<
      TConfig,
      TResource,
      {
        __roles: any;
        inherit: any;
        grant: any;
        assign: any;
        implies: any;
        permissions: Partial<ResourcePermissions<TResource, string, TConfig>>;
      }
    >,
  ) {
    return this as ResourceDefinition<TConfig, TResource, TInner>;
  }

  static create<TConfig extends FrameworkConfig, TResource extends ObjectLike>(
    framework: TConfig,
    resource: Constructor<TResource>,
    name: string,
  ): ResourceDefinition<
    TConfig,
    TResource,
    {
      __roles: never;
      inherit: [];
      assign: [];
      grant: {};
      implies: {};
      permissions: null;
    }
  > {
    return new ResourceDefinition(framework, resource, name, {
      __roles: "" as never,
      inherit: [],
      assign: [],
      grant: {},
      implies: {},
      permissions: null,
    });
  }
}
