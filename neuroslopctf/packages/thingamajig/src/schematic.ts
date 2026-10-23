import {
  USER_ALIAS,
  type CompiledResource,
  type PermissionOperation,
} from "./workbench.js";
import {
  BinaryLogicalExpression,
  type BinaryComparisonExpression,
  type Constructor,
  type CountExpression,
  type DeleteExpression,
  type Expression,
  type ExpressionVisitor,
  type FieldExpression,
  type InExpression,
  type InsertExpression,
  type IsNullExpression,
  type NowExpression,
  type ScalarSelectExpression,
  type ObjectLike,
  type RoleExpression,
  type SelectExistsExpression,
  type SelectExpression,
  type UnaryLogicalExpression,
  type UpdateExpression,
  type ValueExpression,
} from "./clockwork.js";

const OPERATIONS: PermissionOperation[] = ["read", "create", "update", "delete"];
const INDENT = "  ";

export class ExpressionPrinter implements ExpressionVisitor<string> {
  visitValueExpression(expression: ValueExpression<unknown>): string {
    return typeof expression.value === "string"
      ? `'${expression.value}'`
      : String(expression.value);
  }

  visitBinaryLogicalExpression(expression: BinaryLogicalExpression): string {
    const operator = expression.operator === "&&" ? "AND" : "OR";
    const side = (side: Expression<boolean>) => {
      const printed = side.accept(this);

      return side instanceof BinaryLogicalExpression &&
        side.operator !== expression.operator
        ? `(${printed})`
        : printed;
    };

    return `${side(expression.left)} ${operator} ${side(expression.right)}`;
  }

  visitUnaryLogicalExpression(expression: UnaryLogicalExpression): string {
    return `NOT (${expression.expression.accept(this)})`;
  }

  visitBinaryComparisonExpression(
    expression: BinaryComparisonExpression<unknown>,
  ): string {
    return `${expression.left.accept(this)} ${expression.comparator} ${expression.right.accept(this)}`;
  }

  visitFieldExpression(expression: FieldExpression<unknown>): string {
    const object =
      expression.objectName === USER_ALIAS
        ? "current_user"
        : expression.objectName;

    return `${object}.${expression.fieldName}`;
  }

  visitSelectExistsExpression(expression: SelectExistsExpression): string {
    return `exists ${this.source(expression.selectExpression)}`;
  }

  visitSelectExpression(expression: SelectExpression<ObjectLike>): string {
    return `select ${this.source(expression)}`;
  }

  visitCountExpression(expression: CountExpression): string {
    return `count ${this.source(expression.selectExpression)}`;
  }

  visitInsertExpression(expression: InsertExpression<ObjectLike>): string {
    return `insert ${expression.tableName}`;
  }

  visitUpdateExpression(expression: UpdateExpression<ObjectLike>): string {
    return `update ${this.source(expression)}`;
  }

  visitDeleteExpression(expression: DeleteExpression<ObjectLike>): string {
    return `delete ${this.source(expression)}`;
  }

  visitRoleExpression(expression: RoleExpression): string {
    return expression.roleName;
  }

  visitIsNullExpression(expression: IsNullExpression): string {
    return `${expression.expression.accept(this)} is null`;
  }

  visitInExpression(expression: InExpression<unknown>): string {
    const values = expression.values.map((value) => value.accept(this));

    return `${expression.expression.accept(this)} in (${values.join(", ")})`;
  }

  visitNowExpression(_expression: NowExpression): string {
    return "now()";
  }

  visitScalarSelectExpression(
    expression: ScalarSelectExpression<unknown>,
  ): string {
    return `${expression.fieldName} of ${this.source(expression.selectExpression)}`;
  }

  private source(expression: {
    tableName: string;
    objectName: string;
    whereExpressions: Expression<boolean>[];
  }): string {
    const where = expression.whereExpressions
      .map((where) => where.accept(this))
      .join(" AND ");

    return `(${expression.tableName} ${expression.objectName}${where ? ` where ${where}` : ""})`;
  }
}

export function describeResources(
  resources: CompiledResource<ObjectLike>[],
  principal: Constructor<ObjectLike>,
): string {
  const printer = new ExpressionPrinter();
  const lines: string[] = [];
  const printed = new Set<CompiledResource<ObjectLike>>();
  const children = new Map<
    Constructor<ObjectLike>,
    { child: CompiledResource<ObjectLike>; via: Expression<boolean> }[]
  >();

  for (const resource of resources) {
    for (const edge of resource.inherits) {
      const list = children.get(edge.from.class) ?? [];
      list.push({ child: resource, via: edge.via });
      children.set(edge.from.class, list);
    }
  }

  const principalResource = resources.find(
    (resource) => resource.resource === principal,
  );

  lines.push(
    principalResource
      ? `principal: ${principal.name} (resource ${principalResource.name})`
      : `principal: ${principal.name} (warning: no resource registered for it)`,
    "",
  );

  const print = (
    resource: CompiledResource<ObjectLike>,
    depth: number,
    via?: Expression<boolean>,
  ) => {
    const pad = INDENT.repeat(depth);
    const header = `${pad}${resource.name} (${resource.resource.name})${via ? ` via ${via.accept(printer)}` : ""}`;

    if (printed.has(resource)) {
      lines.push(`${header} [see above]`);
      return;
    }

    printed.add(resource);
    lines.push(header);

    const inner = pad + INDENT;
    const own = new Set([
      ...Object.keys(resource.grants),
      ...resource.assigns.flatMap((assign) => assign.roles),
      ...Object.keys(resource.implies),
      ...Object.values(resource.implies).flat(),
    ]);
    const inherited = resource.roles.filter((role) => !own.has(role));

    lines.push(
      `${inner}roles: ${[...own].join(", ") || "-"}${inherited.length > 0 ? ` (inherited: ${inherited.join(", ")})` : ""}`,
    );

    for (const [role, grant] of Object.entries(resource.grants)) {
      lines.push(`${inner}grant ${role}: ${grant.accept(printer)}`);
    }

    for (const assign of resource.assigns) {
      lines.push(
        `${inner}assign ${assign.roles.join(" | ")}: ${assign.expression.accept(printer)}`,
      );
    }

    for (const [role, implied] of Object.entries(resource.implies)) {
      lines.push(`${inner}implies ${role} -> ${implied.join(", ")}`);
    }

    for (const operation of OPERATIONS) {
      const permission = resource.permissions[operation];

      lines.push(
        `${inner}${operation}: ${permission ? permission.accept(printer) : "denied"}`,
      );
    }

    for (const { child, via } of children.get(resource.resource) ?? []) {
      print(child, depth + 1, via);
    }
  };

  for (const resource of resources) {
    if (resource.inherits.length === 0) {
      print(resource, 0);
    }
  }

  return lines.join("\n");
}
