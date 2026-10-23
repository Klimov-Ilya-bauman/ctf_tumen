import {
  USER_ALIAS,
  type Application,
  type CompiledResource,
  type PermissionOperation,
} from "./workbench.js";
import { SqlVisitor } from "./foundry.js";
import {
  BinaryComparisonExpression,
  BinaryLogicalExpression,
  CountExpression,
  DeleteExpression,
  FieldExpression,
  InExpression,
  InsertExpression,
  IsNullExpression,
  QueryContext,
  ScalarSelectExpression,
  SelectExistsExpression,
  SelectExpression,
  UnaryLogicalExpression,
  UpdateExpression,
  ValueExpression,
  type Expression,
  type ExpressionVisitor,
  type NowExpression,
  type ObjectLike,
  type RoleExpression,
} from "./clockwork.js";

export interface SqlDriver {
  query<TRow extends ObjectLike>(sql: string): Promise<TRow[]>;
  transaction<TResult>(
    callback: (driver: SqlDriver) => Promise<TResult>,
  ): Promise<TResult>;
}

export class ForbiddenError extends Error {}

export class ConflictError extends Error {
  constructor(
    message: string,
    public readonly constraint?: string,
  ) {
    super(message);
  }
}

export class ConstraintError extends Error {
  constructor(
    message: string,
    public readonly constraint?: string,
  ) {
    super(message);
  }
}

type Statement =
  | SelectExpression<ObjectLike, any>
  | CountExpression<any>
  | InsertExpression<ObjectLike>
  | UpdateExpression<ObjectLike, any>
  | DeleteExpression<ObjectLike, any>;

type MutationExpression<TResource extends ObjectLike> =
  | InsertExpression<TResource>
  | UpdateExpression<TResource, any>
  | DeleteExpression<TResource, any>;

export class Orm<TUserResource extends ObjectLike> {
  private sql = new SqlVisitor();

  constructor(
    private app: Application<TUserResource>,
    private driver: SqlDriver,
  ) {}

  private get connection(): SqlDriver {
    return this.app.getExecutionContextManager().currentDriver() ?? this.driver;
  }

  async fetchAll<TResource extends ObjectLike>(
    select: SelectExpression<TResource, any>,
  ): Promise<TResource[]> {
    const rows = await this.connection.query<TResource>(this.compile(select));

    return this.hydrate(select, rows);
  }

  fetch(count: CountExpression<any>): Promise<number>;
  fetch<TResource extends ObjectLike>(
    select: SelectExpression<TResource, any>,
  ): Promise<TResource | null>;
  async fetch(
    expression: SelectExpression<ObjectLike, any> | CountExpression<any>,
  ): Promise<ObjectLike | number | null> {
    const sql = this.compile(expression);

    if (expression instanceof CountExpression) {
      const [row] = await this.connection.query<{ count: number | string }>(
        `SELECT ${sql} AS "count"`,
      );

      return Number(row?.count ?? 0);
    }

    const [row] = await this.connection.query(`${sql} LIMIT 1`);

    if (row) {
      return this.hydrate(expression, [row])[0]!;
    }

    await this.assertNothingHidden(expression);

    return null;
  }

  async execute<TResource extends ObjectLike>(
    statement: MutationExpression<TResource>,
  ): Promise<TResource[]> {
    const rows = await this.connection.query<TResource>(this.compile(statement));

    if (rows.length === 0) {
      if (statement instanceof InsertExpression) {
        throw new ForbiddenError(
          `Not allowed to create ${statement.tableName}`,
        );
      }

      await this.assertNothingHidden(statement);
    }

    return this.hydrate(statement, rows);
  }

  transaction<TResult>(
    callback: (orm: Orm<TUserResource>) => Promise<TResult>,
  ): Promise<TResult> {
    const manager = this.app.getExecutionContextManager();

    return this.connection.transaction((driver) => {
      const scoped = new Orm(this.app, driver);

      return manager.hasContext()
        ? manager.runWithDriver(driver, () => callback(scoped))
        : callback(scoped);
    });
  }

  raw<TRow extends ObjectLike>(sql: string): Promise<TRow[]> {
    return this.connection.query<TRow>(sql);
  }

  private compile(statement: Statement): string {
    return this.resolver().secure(statement).accept(this.sql);
  }

  private async assertNothingHidden(
    statement:
      | SelectExpression<ObjectLike, any>
      | UpdateExpression<ObjectLike, any>
      | DeleteExpression<ObjectLike, any>,
  ) {
    const resolver = this.resolver();

    if (resolver.hasRootAccess) {
      return;
    }

    const probe = resolver.unchecked(statement).accept(this.sql);
    const [row] = await this.connection.query<{ count: number | string }>(
      `SELECT ${probe} AS "count"`,
    );

    if (Number(row?.count ?? 0) > 0) {
      throw new ForbiddenError(
        `Not allowed to ${operationOf(statement)} ${statement.tableName}`,
      );
    }
  }

  private resolver(): AccessResolver<TUserResource> {
    const context = this.app.getExecutionContextManager().storage.getStore();

    if (!context) {
      throw new Error("No user context available");
    }

    return new AccessResolver(this.app, context.user, context.hasRootAccess);
  }

  private hydrate<TResource extends ObjectLike>(
    statement:
      | SelectExpression<TResource, any>
      | MutationExpression<TResource>,
    rows: TResource[],
  ): TResource[] {
    return rows.map((row) =>
      Object.assign(new statement.what.resource(), row),
    );
  }
}

export class AccessResolver<TUserResource extends ObjectLike>
  implements ExpressionVisitor<Expression<any>>
{
  private queryContext = new QueryContext();
  private aliases = new Map<string, string>();
  private scope: { resource: CompiledResource<ObjectLike>; alias: string } | null =
    null;

  constructor(
    private app: Application<TUserResource>,
    private user: TUserResource,
    readonly hasRootAccess: boolean,
  ) {}

  secure<TStatement extends Statement>(statement: TStatement): TStatement {
    const rewritten = this.rewrite<unknown>(statement, new Map()) as Statement;
    const target =
      rewritten instanceof CountExpression
        ? rewritten.selectExpression
        : rewritten;

    const resource = this.app.getCompiledResource(target.what.resource);

    target.whereExpressions.push(
      this.permission(resource, operationOf(rewritten), target.objectName),
    );

    return rewritten as TStatement;
  }

  unchecked(
    statement:
      | SelectExpression<ObjectLike, any>
      | UpdateExpression<ObjectLike, any>
      | DeleteExpression<ObjectLike, any>,
  ): CountExpression {
    const select = new SelectExpression(this.queryContext, statement.what);

    this.rewriteWheres(statement, select);

    return select.count();
  }

  rewrite<TValue>(
    expression: Expression<TValue>,
    aliases: Map<string, string>,
  ): Expression<TValue> {
    const previous = this.aliases;
    this.aliases = aliases;

    try {
      return expression.accept(this);
    } finally {
      this.aliases = previous;
    }
  }

  visitValueExpression(expression: ValueExpression<unknown>): Expression<any> {
    return expression;
  }

  visitBinaryLogicalExpression(
    expression: BinaryLogicalExpression,
  ): Expression<any> {
    return new BinaryLogicalExpression(
      this.queryContext,
      expression.operator,
      expression.left.accept(this),
      expression.right.accept(this),
    );
  }

  visitUnaryLogicalExpression(
    expression: UnaryLogicalExpression,
  ): Expression<any> {
    return new UnaryLogicalExpression(
      this.queryContext,
      expression.operator,
      expression.expression.accept(this),
    );
  }

  visitBinaryComparisonExpression(
    expression: BinaryComparisonExpression<unknown>,
  ): Expression<any> {
    return new BinaryComparisonExpression(
      this.queryContext,
      expression.comparator,
      expression.left.accept(this),
      expression.right.accept(this),
    );
  }

  visitFieldExpression(expression: FieldExpression<unknown>): Expression<any> {
    if (expression.objectName === USER_ALIAS) {
      return new ValueExpression(
        this.queryContext,
        this.user[expression.fieldName],
      );
    }

    return new FieldExpression(
      this.queryContext,
      this.aliases.get(expression.objectName) ?? expression.objectName,
      expression.fieldName,
    );
  }

  visitSelectExistsExpression(
    expression: SelectExistsExpression,
  ): Expression<any> {
    return new SelectExistsExpression(
      this.queryContext,
      this.rewriteSelect(expression.selectExpression),
    );
  }

  visitSelectExpression(
    expression: SelectExpression<ObjectLike>,
  ): Expression<any> {
    return this.rewriteSelect(expression);
  }

  visitCountExpression(expression: CountExpression): Expression<any> {
    return new CountExpression(
      this.queryContext,
      this.rewriteSelect(expression.selectExpression),
    );
  }

  visitInsertExpression(
    expression: InsertExpression<ObjectLike>,
  ): Expression<any> {
    const insert = new InsertExpression(
      this.queryContext,
      expression.what,
      expression.values,
    );

    this.rewriteWheres(expression, insert);

    return insert;
  }

  visitUpdateExpression(
    expression: UpdateExpression<ObjectLike>,
  ): Expression<any> {
    const update = new UpdateExpression(
      this.queryContext,
      expression.what,
      expression.values,
    );

    this.rewriteWheres(expression, update);

    return update;
  }

  visitDeleteExpression(
    expression: DeleteExpression<ObjectLike>,
  ): Expression<any> {
    const deletion = new DeleteExpression(this.queryContext, expression.what);

    this.rewriteWheres(expression, deletion);

    return deletion;
  }

  visitIsNullExpression(expression: IsNullExpression): Expression<any> {
    return new IsNullExpression(
      this.queryContext,
      expression.expression.accept(this),
    );
  }

  visitInExpression(expression: InExpression<unknown>): Expression<any> {
    return new InExpression(
      this.queryContext,
      expression.expression.accept(this),
      expression.values.map((value) => value.accept(this)),
    );
  }

  visitNowExpression(expression: NowExpression): Expression<any> {
    return expression;
  }

  visitScalarSelectExpression(
    expression: ScalarSelectExpression<unknown>,
  ): Expression<any> {
    return new ScalarSelectExpression(
      this.queryContext,
      this.rewriteSelect(expression.selectExpression),
      expression.fieldName,
    );
  }

  visitRoleExpression(expression: RoleExpression): Expression<any> {
    if (!this.scope) {
      throw new Error(
        `Role ${expression.roleName} referenced outside of a permission`,
      );
    }

    return this.resolveRole(
      this.scope.resource,
      this.scope.alias,
      expression.roleName,
      new Set(),
    );
  }

  private permission(
    resource: CompiledResource<ObjectLike>,
    operation: PermissionOperation,
    alias: string,
  ): Expression<boolean> {
    if (this.hasRootAccess) {
      return new ValueExpression(this.queryContext, true);
    }

    const expression = resource.permissions[operation];

    if (!expression) {
      return new ValueExpression(this.queryContext, false);
    }

    const previous = this.scope;
    this.scope = { resource, alias };

    try {
      return this.rewrite(expression, new Map([[resource.name, alias]]));
    } finally {
      this.scope = previous;
    }
  }

  private rewriteSelect(
    expression: SelectExpression<ObjectLike>,
  ): SelectExpression<ObjectLike> {
    const select = new SelectExpression(this.queryContext, expression.what);
    const aliases = this.rewriteWheres(expression, select);

    for (const { expression: order, direction } of expression.orderExpressions) {
      select.orderExpressions.push({
        expression: this.rewrite(order, aliases),
        direction,
      });
    }

    select.limitCount = expression.limitCount;
    select.offsetCount = expression.offsetCount;

    return select;
  }

  private rewriteWheres(
    source: { objectName: string; whereExpressions: Expression<boolean>[] },
    target: { objectName: string; whereExpressions: Expression<boolean>[] },
  ) {
    const aliases = new Map(this.aliases).set(
      source.objectName,
      target.objectName,
    );

    for (const where of source.whereExpressions) {
      target.whereExpressions.push(this.rewrite(where, aliases));
    }

    return aliases;
  }

  private resolveRole(
    resource: CompiledResource<ObjectLike>,
    alias: string,
    role: string,
    visited: Set<string>,
  ): Expression<boolean> {
    const key = `${resource.name}:${role}`;

    if (visited.has(key)) {
      return new ValueExpression(this.queryContext, false);
    }

    const path = new Set(visited).add(key);
    const aliases = new Map([[resource.name, alias]]);
    const alternatives: Expression<boolean>[] = [];
    const grant = resource.grants[role];

    if (grant) {
      alternatives.push(this.rewrite(grant, aliases));
    }

    for (const assign of resource.assigns) {
      if (assign.roles.includes(role)) {
        alternatives.push(
          new BinaryComparisonExpression(
            this.queryContext,
            "=",
            this.rewrite(assign.expression, aliases),
            new ValueExpression(this.queryContext, role),
          ),
        );
      }
    }

    for (const [implying, implied] of Object.entries(resource.implies)) {
      if (implied.includes(role)) {
        alternatives.push(this.resolveRole(resource, alias, implying, path));
      }
    }

    for (const edge of resource.inherits) {
      const parent = this.app.getCompiledResource(edge.from.class);

      if (!parent.roles.includes(role)) {
        continue;
      }

      const select = new SelectExpression(this.queryContext, parent.definition);
      const viaAliases = new Map([
        [resource.name, alias],
        [parent.name, select.objectName],
      ]);

      select.whereExpressions.push(
        this.rewrite(edge.via, viaAliases),
        this.resolveRole(parent, select.objectName, role, path),
      );

      alternatives.push(select.exists());
    }

    const [first, ...rest] = alternatives;

    if (!first) {
      return new ValueExpression(this.queryContext, false);
    }

    return rest.reduce<Expression<boolean>>(
      (combined, alternative) => combined.or(alternative),
      first,
    );
  }
}

function operationOf(statement: Statement): PermissionOperation {
  if (statement instanceof InsertExpression) {
    return "create";
  } else if (statement instanceof UpdateExpression) {
    return "update";
  } else if (statement instanceof DeleteExpression) {
    return "delete";
  } else {
    return "read";
  }
}
