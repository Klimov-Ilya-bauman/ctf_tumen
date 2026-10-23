import {
  SelectExpression,
  type BinaryComparisonExpression,
  type CountExpression,
  type DeleteExpression,
  type Expression,
  type InExpression,
  type InsertExpression,
  type IsNullExpression,
  type MatchOperator,
  type NowExpression,
  type ScalarSelectExpression,
  type UpdateExpression,
  type BinaryLogicalExpression,
  type ComparatorLiteral,
  type ExpressionVisitor,
  type FieldExpression,
  type ObjectLike,
  type RoleExpression,
  type SelectExistsExpression,
  type UnaryLogicalExpression,
  type ValueExpression,
} from "./clockwork.js";

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export class SqlVisitor implements ExpressionVisitor<string> {
  visitValueExpression(expression: ValueExpression<unknown>): string {
    return this.formatValue(expression.value);
  }

  private formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "NULL";
    } else if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    } else if (typeof value === "string") {
      return `'${value}'`;
    } else {
      return String(value);
    }
  }

  private mapComparator(comparator: ComparatorLiteral | MatchOperator): string {
    switch (comparator) {
      case "LIKE":
        return "LIKE";
      case "ILIKE":
        return "ILIKE";
      case "=":
        return "=";
      case "!=":
        return "<>";
      case "<":
        return "<";
      case ">":
        return ">";
      case "<=":
        return "<=";
      case ">=":
        return ">=";
    }
  }

  visitBinaryLogicalExpression(expression: BinaryLogicalExpression): string {
    const left = expression.left.accept(this);
    const right = expression.right.accept(this);
    const operator = this.mapOperator(expression.operator);

    return `(${left} ${operator} ${right})`;
  }

  visitUnaryLogicalExpression(expression: UnaryLogicalExpression): string {
    const inner = expression.expression.accept(this);
    return `NOT (${inner})`;
  }

  visitBinaryComparisonExpression(
    expression: BinaryComparisonExpression<unknown>,
  ): string {
    const left = expression.left.accept(this);
    const right = expression.right.accept(this);
    const operator = this.mapComparator(expression.comparator);

    return `(${left} ${operator} ${right})`;
  }

  visitFieldExpression(expression: FieldExpression<unknown>): string {
    return `${quoteIdentifier(expression.objectName)}.${quoteIdentifier(expression.fieldName)}`;
  }

  visitSelectExistsExpression(expression: SelectExistsExpression): string {
    const select = expression.selectExpression;
    let whereClause: string;

    if (select.whereExpressions.length > 0) {
      const wherePredicates = select.whereExpressions.map((expr) =>
        expr.accept(this),
      );

      whereClause = ` WHERE ${wherePredicates.join(" AND ")}`;
    } else {
      whereClause = "";
    }

    return `(SELECT COUNT(*) FROM ${quoteIdentifier(select.tableName)} AS ${quoteIdentifier(select.objectName)}${whereClause}) > 0`;
  }

  visitSelectExpression(expression: SelectExpression<ObjectLike>): string {
    return `(SELECT * FROM ${this.source(expression)}${this.whereClause(expression.whereExpressions)}${this.orderClause(expression)}${this.pageClause(expression)})`;
  }

  visitScalarSelectExpression(
    expression: ScalarSelectExpression<unknown>,
  ): string {
    const select = expression.selectExpression;
    const field = `${quoteIdentifier(select.objectName)}.${quoteIdentifier(expression.fieldName)}`;

    return `(SELECT ${field} FROM ${this.source(select)}${this.whereClause(select.whereExpressions)}${this.orderClause(select)} LIMIT 1)`;
  }

  visitIsNullExpression(expression: IsNullExpression): string {
    return `(${expression.expression.accept(this)} IS NULL)`;
  }

  visitInExpression(expression: InExpression<unknown>): string {
    if (expression.values.length === 0) {
      return "FALSE";
    }

    const values = expression.values.map((value) => value.accept(this));

    return `(${expression.expression.accept(this)} IN (${values.join(", ")}))`;
  }

  visitNowExpression(_expression: NowExpression): string {
    return "now()";
  }

  private source(expression: { tableName: string; objectName: string }) {
    return `${quoteIdentifier(expression.tableName)} AS ${quoteIdentifier(expression.objectName)}`;
  }

  private orderClause(expression: SelectExpression<ObjectLike>): string {
    if (expression.orderExpressions.length === 0) {
      return "";
    }

    const terms = expression.orderExpressions.map(
      ({ expression, direction }) =>
        `${expression.accept(this)} ${direction === "desc" ? "DESC" : "ASC"}`,
    );

    return ` ORDER BY ${terms.join(", ")}`;
  }

  private pageClause(expression: SelectExpression<ObjectLike>): string {
    const limit =
      expression.limitCount === null
        ? ""
        : ` LIMIT ${Math.trunc(expression.limitCount)}`;
    const offset =
      expression.offsetCount === null
        ? ""
        : ` OFFSET ${Math.trunc(expression.offsetCount)}`;

    return limit + offset;
  }

  private mapOperator(operator: "&&" | "||"): string {
    switch (operator) {
      case "&&":
        return "AND";
      case "||":
        return "OR";
    }
  }

  visitCountExpression(expression: CountExpression): string {
    const select = expression.selectExpression;

    return `(SELECT COUNT(*) FROM ${quoteIdentifier(select.tableName)} AS ${quoteIdentifier(select.objectName)}${this.whereClause(select.whereExpressions)})`;
  }

  visitInsertExpression(expression: InsertExpression<ObjectLike>): string {
    const table = quoteIdentifier(expression.tableName);
    const alias = quoteIdentifier(expression.objectName);
    const columns = this.definedColumns(expression.values);
    const candidate = this.formatValue(
      JSON.stringify(
        Object.fromEntries(
          columns.map((column) => [column, expression.values[column]]),
        ),
      ),
    );

    return (
      `INSERT INTO ${table} (${columns.map(quoteIdentifier).join(", ")}) ` +
      `SELECT ${columns.map((column) => `${alias}.${quoteIdentifier(column)}`).join(", ")} ` +
      `FROM jsonb_populate_record(NULL::${table}, ${candidate}::jsonb) AS ${alias}` +
      `${this.whereClause(expression.whereExpressions)} RETURNING *`
    );
  }

  visitUpdateExpression(expression: UpdateExpression<ObjectLike>): string {
    const assignments = this.definedColumns(expression.values).map(
      (column) =>
        `${quoteIdentifier(column)} = ${this.formatValue(expression.values[column])}`,
    );

    return (
      `UPDATE ${quoteIdentifier(expression.tableName)} AS ${quoteIdentifier(expression.objectName)} ` +
      `SET ${assignments.join(", ")}` +
      `${this.whereClause(expression.whereExpressions)} RETURNING *`
    );
  }

  visitDeleteExpression(expression: DeleteExpression<ObjectLike>): string {
    return (
      `DELETE FROM ${quoteIdentifier(expression.tableName)} AS ${quoteIdentifier(expression.objectName)}` +
      `${this.whereClause(expression.whereExpressions)} RETURNING *`
    );
  }

  private whereClause(expressions: Expression<boolean>[]): string {
    if (expressions.length === 0) {
      return "";
    }

    return ` WHERE ${expressions.map((expr) => expr.accept(this)).join(" AND ")}`;
  }

  private definedColumns(values: ObjectLike): string[] {
    return Object.keys(values).filter((key) => values[key] !== undefined);
  }

  visitRoleExpression(expression: RoleExpression): string {
    throw new Error(
      "Access expressions cannot be visited directly in SQL. They should be resolved to a boolean expression before visiting.",
    );
  }
}
