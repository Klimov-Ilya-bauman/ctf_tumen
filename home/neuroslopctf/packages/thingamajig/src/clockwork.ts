import type { ResourceDefinition } from "./blueprint.js";

export type Constructor<TInstance> = new (...args: any[]) => TInstance;
export type ObjectLike = Record<string, any>;
export type ComparatorLiteral = "=" | "!=" | "<" | ">" | "<=" | ">=";
export type MatchOperator = "LIKE" | "ILIKE";
export type SortDirection = "asc" | "desc";

export interface ExpressionTagRegistry {
  base: true;
  sql: true;
  access: true;
}

export type ExpressionTag = keyof ExpressionTagRegistry;

export type TagsOf<TExpression> =
  TExpression extends Expression<any, infer TTags> ? TTags : never;

export interface ExpressionVisitor<TReturn> {
  visitValueExpression(expression: ValueExpression<unknown>): TReturn;
  visitBinaryLogicalExpression(expression: BinaryLogicalExpression): TReturn;
  visitUnaryLogicalExpression(expression: UnaryLogicalExpression): TReturn;
  visitBinaryComparisonExpression(
    expression: BinaryComparisonExpression<unknown>,
  ): TReturn;
  visitFieldExpression(expression: FieldExpression<unknown>): TReturn;
  visitSelectExistsExpression(expression: SelectExistsExpression): TReturn;
  visitSelectExpression(expression: SelectExpression<ObjectLike>): TReturn;
  visitRoleExpression(expression: RoleExpression): TReturn;
  visitCountExpression(expression: CountExpression): TReturn;
  visitInsertExpression(expression: InsertExpression<ObjectLike>): TReturn;
  visitUpdateExpression(expression: UpdateExpression<ObjectLike>): TReturn;
  visitDeleteExpression(expression: DeleteExpression<ObjectLike>): TReturn;
  visitIsNullExpression(expression: IsNullExpression): TReturn;
  visitInExpression(expression: InExpression<unknown>): TReturn;
  visitNowExpression(expression: NowExpression): TReturn;
  visitScalarSelectExpression(
    expression: ScalarSelectExpression<unknown>,
  ): TReturn;
}

export class QueryContext {
  private objectCounter = 0;

  getUniqueObjectName(): string {
    this.objectCounter++;
    return `obj${this.objectCounter}`;
  }
}

export abstract class Expression<
  TValue,
  TTags extends ExpressionTag = ExpressionTag,
> {
  private __phantom!: TValue;
  private __tags!: TTags;

  constructor(protected queryContext: QueryContext) {}

  abstract accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn;

  and<TOther extends ExpressionTag>(
    this: Expression<boolean, TTags>,
    other: Expression<boolean, TOther>,
  ): BinaryLogicalExpression<TTags | TOther> {
    return new BinaryLogicalExpression<TTags | TOther>(
      this.queryContext,
      "&&",
      this,
      other,
    );
  }

  or<TOther extends ExpressionTag>(
    this: Expression<boolean, TTags>,
    other: Expression<boolean, TOther>,
  ): BinaryLogicalExpression<TTags | TOther> {
    return new BinaryLogicalExpression<TTags | TOther>(
      this.queryContext,
      "||",
      this,
      other,
    );
  }

  not(this: Expression<boolean, TTags>): UnaryLogicalExpression<TTags> {
    return new UnaryLogicalExpression(this.queryContext, "!", this);
  }

  equals<TOther extends ExpressionTag>(
    other: Expression<TValue, TOther>,
  ): BinaryComparisonExpression<TValue, TTags | TOther> {
    return new BinaryComparisonExpression<TValue, TTags | TOther>(
      this.queryContext,
      "=",
      this,
      other,
    );
  }

  notEquals<TOther extends ExpressionTag>(
    other: Expression<TValue, TOther>,
  ): BinaryComparisonExpression<TValue, TTags | TOther> {
    return new BinaryComparisonExpression<TValue, TTags | TOther>(
      this.queryContext,
      "!=",
      this,
      other,
    );
  }

  compare<TOther extends ExpressionTag>(
    comparator: ComparatorLiteral,
    other: Expression<TValue, TOther>,
  ): BinaryComparisonExpression<TValue, TTags | TOther> {
    return new BinaryComparisonExpression<TValue, TTags | TOther>(
      this.queryContext,
      comparator,
      this,
      other,
    );
  }

  like<TOther extends ExpressionTag>(
    this: Expression<string | null | undefined, TTags>,
    pattern: Expression<string, TOther>,
  ): BinaryComparisonExpression<string, TTags | TOther> {
    return new BinaryComparisonExpression<string, TTags | TOther>(
      this.queryContext,
      "LIKE",
      this as Expression<string, TTags>,
      pattern,
    );
  }

  ilike<TOther extends ExpressionTag>(
    this: Expression<string | null | undefined, TTags>,
    pattern: Expression<string, TOther>,
  ): BinaryComparisonExpression<string, TTags | TOther> {
    return new BinaryComparisonExpression<string, TTags | TOther>(
      this.queryContext,
      "ILIKE",
      this as Expression<string, TTags>,
      pattern,
    );
  }

  isNull(): IsNullExpression<TTags> {
    return new IsNullExpression(this.queryContext, this);
  }

  in<TOther extends ExpressionTag = never>(
    values: readonly (TValue | Expression<TValue, TOther>)[],
  ): InExpression<TValue, TTags | TOther> {
    return new InExpression<TValue, TTags | TOther>(
      this.queryContext,
      this,
      values.map((item) =>
        item instanceof Expression
          ? item
          : new ValueExpression(this.queryContext, item),
      ),
    );
  }
}

export class ValueExpression<TValue> extends Expression<TValue, never> {
  constructor(
    queryContext: QueryContext,
    public value: TValue,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitValueExpression(this);
  }
}

export class BinaryLogicalExpression<
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<boolean, "base" | TTags> {
  constructor(
    queryContext: QueryContext,
    public operator: "&&" | "||",
    public left: Expression<boolean, TTags>,
    public right: Expression<boolean, TTags>,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitBinaryLogicalExpression(this);
  }
}

export class UnaryLogicalExpression<
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<boolean, "base" | TTags> {
  constructor(
    queryContext: QueryContext,
    public operator: "!",
    public expression: Expression<boolean, TTags>,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitUnaryLogicalExpression(this);
  }
}

export class BinaryComparisonExpression<
  TValue,
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<boolean, "base" | TTags> {
  constructor(
    queryContext: QueryContext,
    public comparator: ComparatorLiteral | MatchOperator,
    public left: Expression<TValue, TTags>,
    public right: Expression<TValue, TTags>,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitBinaryComparisonExpression(this);
  }
}

export class IsNullExpression<
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<boolean, "base" | TTags> {
  constructor(
    queryContext: QueryContext,
    public readonly expression: Expression<unknown, TTags>,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitIsNullExpression(this);
  }
}

export class InExpression<
  TValue,
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<boolean, "base" | TTags> {
  constructor(
    queryContext: QueryContext,
    public readonly expression: Expression<TValue, TTags>,
    public readonly values: Expression<TValue, TTags>[],
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitInExpression(this);
  }
}

export class NowExpression extends Expression<Date, "sql"> {
  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitNowExpression(this);
  }
}

export class FieldExpression<TValue> extends Expression<TValue, never> {
  constructor(
    queryContext: QueryContext,
    public objectName: string,
    public fieldName: string,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitFieldExpression(this);
  }
}

export class SelectExistsExpression<
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<boolean, "sql" | TTags> {
  constructor(
    queryContext: QueryContext,
    public selectExpression: SelectExpression<ObjectLike, TTags>,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitSelectExistsExpression(this);
  }
}

export class SelectExpression<
  TValue extends ObjectLike,
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<TValue, "sql" | TTags> {
  public readonly whereExpressions: Expression<boolean>[] = [];
  public readonly orderExpressions: {
    expression: Expression<unknown>;
    direction: SortDirection;
  }[] = [];
  public limitCount: number | null = null;
  public offsetCount: number | null = null;
  public readonly objectName: string;
  public readonly tableName: string;

  constructor(
    queryContext: QueryContext,
    public readonly what: ResourceDefinition<any, TValue, any>,
  ) {
    super(queryContext);

    this.objectName = this.queryContext.getUniqueObjectName();
    this.tableName = what.name;
  }

  where<TPredicateTags extends ExpressionTag>(
    predicate: (
      context: ContextAccessor<TValue>,
    ) => Expression<boolean, TPredicateTags>,
  ): SelectExpression<TValue, TTags | TPredicateTags> {
    this.whereExpressions.push(
      buildPredicate(this.what, this.objectName, this.queryContext, predicate),
    );

    return this as SelectExpression<TValue, TTags | TPredicateTags>;
  }

  orderBy(
    selector: (context: ContextAccessor<TValue>) => Expression<unknown>,
    direction: SortDirection = "asc",
  ): this {
    this.orderExpressions.push({
      expression: selector(
        createContextAccessor(
          this.what.resource,
          this.objectName,
          this.queryContext,
        ),
      ),
      direction,
    });

    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  offset(count: number): this {
    this.offsetCount = count;
    return this;
  }

  exists(): SelectExistsExpression<TTags> {
    return new SelectExistsExpression(this.queryContext, this);
  }

  count(): CountExpression<TTags> {
    return new CountExpression(this.queryContext, this);
  }

  pick<TField extends keyof TValue & string>(
    field: TField,
  ): ScalarSelectExpression<TValue[TField], TTags> {
    return new ScalarSelectExpression(this.queryContext, this, field);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitSelectExpression(this);
  }
}

export class ScalarSelectExpression<
  TValue,
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<TValue, "sql" | TTags> {
  constructor(
    queryContext: QueryContext,
    public readonly selectExpression: SelectExpression<ObjectLike, TTags>,
    public readonly fieldName: string,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitScalarSelectExpression(this);
  }
}

export class CountExpression<
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<number, "sql" | TTags> {
  constructor(
    queryContext: QueryContext,
    public readonly selectExpression: SelectExpression<ObjectLike, TTags>,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitCountExpression(this);
  }
}

export class InsertExpression<TValue extends ObjectLike> extends Expression<
  TValue[],
  "sql"
> {
  public readonly whereExpressions: Expression<boolean>[] = [];
  public readonly objectName: string;
  public readonly tableName: string;

  constructor(
    queryContext: QueryContext,
    public readonly what: ResourceDefinition<any, TValue, any>,
    public readonly values: Partial<TValue>,
  ) {
    super(queryContext);

    assertKnownFields(what, values);
    this.objectName = this.queryContext.getUniqueObjectName();
    this.tableName = what.name;
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitInsertExpression(this);
  }
}

export class UpdateExpression<
  TValue extends ObjectLike,
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<TValue[], "sql" | TTags> {
  public readonly whereExpressions: Expression<boolean>[] = [];
  public readonly objectName: string;
  public readonly tableName: string;

  constructor(
    queryContext: QueryContext,
    public readonly what: ResourceDefinition<any, TValue, any>,
    public readonly values: Partial<TValue>,
  ) {
    super(queryContext);

    assertKnownFields(what, values);
    this.objectName = this.queryContext.getUniqueObjectName();
    this.tableName = what.name;
  }

  where<TPredicateTags extends ExpressionTag>(
    predicate: (
      context: ContextAccessor<TValue>,
    ) => Expression<boolean, TPredicateTags>,
  ): UpdateExpression<TValue, TTags | TPredicateTags> {
    this.whereExpressions.push(
      buildPredicate(this.what, this.objectName, this.queryContext, predicate),
    );

    return this as UpdateExpression<TValue, TTags | TPredicateTags>;
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitUpdateExpression(this);
  }
}

export class DeleteExpression<
  TValue extends ObjectLike,
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<TValue[], "sql" | TTags> {
  public readonly whereExpressions: Expression<boolean>[] = [];
  public readonly objectName: string;
  public readonly tableName: string;

  constructor(
    queryContext: QueryContext,
    public readonly what: ResourceDefinition<any, TValue, any>,
  ) {
    super(queryContext);

    this.objectName = this.queryContext.getUniqueObjectName();
    this.tableName = what.name;
  }

  where<TPredicateTags extends ExpressionTag>(
    predicate: (
      context: ContextAccessor<TValue>,
    ) => Expression<boolean, TPredicateTags>,
  ): DeleteExpression<TValue, TTags | TPredicateTags> {
    this.whereExpressions.push(
      buildPredicate(this.what, this.objectName, this.queryContext, predicate),
    );

    return this as DeleteExpression<TValue, TTags | TPredicateTags>;
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitDeleteExpression(this);
  }
}

export class RoleExpression<
  TTags extends ExpressionTag = ExpressionTag,
> extends Expression<boolean, "access" | TTags> {
  constructor(
    queryContext: QueryContext,
    public roleName: string,
  ) {
    super(queryContext);
  }

  accept<TReturn>(visitor: ExpressionVisitor<TReturn>): TReturn {
    return visitor.visitRoleExpression(this);
  }
}

export type ContextAccessor<TRow extends ObjectLike> = {
  [K in keyof TRow]: FieldAccessor<TRow[K]>;
} & {
  subselect<TValue extends ObjectLike>(
    what: ResourceDefinition<any, TValue, any>,
  ): SelectExpression<TValue, never>;
};

type FieldAccessor<TValue> = {
  value(): FieldExpression<TValue>;
};

export function createContextAccessor<TResource extends ObjectLike>(
  what: Constructor<TResource>,
  objectName: string,
  queryContext: QueryContext = new QueryContext(),
): ContextAccessor<TResource> {
  const fields = listFields(what);

  const accessor = Object.fromEntries(
    fields.map((field) => [
      field,
      {
        value: () => new FieldExpression(queryContext, objectName, field),
      },
    ]),
  ) as ContextAccessor<TResource>;

  accessor.subselect = <TValue extends ObjectLike>(
    what: ResourceDefinition<any, TValue, any>,
  ): SelectExpression<TValue, never> => {
    return new SelectExpression(queryContext, what);
  };

  return accessor;
}

function buildPredicate<TValue extends ObjectLike, TTags extends ExpressionTag>(
  what: ResourceDefinition<any, TValue, any>,
  objectName: string,
  queryContext: QueryContext,
  predicate: (context: ContextAccessor<TValue>) => Expression<boolean, TTags>,
): Expression<boolean, TTags> {
  return predicate(
    createContextAccessor(what.resource, objectName, queryContext),
  );
}

function assertKnownFields(
  what: ResourceDefinition<any, ObjectLike, any>,
  values: ObjectLike,
) {
  const fields = new Set(listFields(what.resource));

  for (const key of Object.keys(values)) {
    if (!fields.has(key)) {
      throw new Error(`Unknown field ${what.name}.${key}`);
    }
  }
}

function listFields(what: Constructor<ObjectLike>): string[] {
  try {
    const instance = new what();

    return Reflect.ownKeys(instance).filter(
      (key) => typeof key === "string",
    ) as string[];
  } catch (e) {
    throw new Error(
      `Failed to instantiate class ${what.name}. Ensure it has a parameterless constructor.`,
    );
  }
}

export function query() {
  return {
    select<TValue extends ObjectLike>(
      what: ResourceDefinition<any, TValue, any>,
    ): SelectExpression<TValue, never> {
      return new SelectExpression(new QueryContext(), what);
    },

    insert<TValue extends ObjectLike>(
      what: ResourceDefinition<any, TValue, any>,
      values: Partial<TValue>,
    ): InsertExpression<TValue> {
      return new InsertExpression(new QueryContext(), what, values);
    },

    update<TValue extends ObjectLike>(
      what: ResourceDefinition<any, TValue, any>,
      values: Partial<TValue>,
    ): UpdateExpression<TValue, never> {
      return new UpdateExpression(new QueryContext(), what, values);
    },

    delete<TValue extends ObjectLike>(
      what: ResourceDefinition<any, TValue, any>,
    ): DeleteExpression<TValue, never> {
      return new DeleteExpression(new QueryContext(), what);
    },
  };
}

export function value<TValue>(value: TValue): ValueExpression<TValue> {
  return new ValueExpression(new QueryContext(), value);
}

export function now(): NowExpression {
  return new NowExpression(new QueryContext());
}
