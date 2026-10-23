
export type ValidationIssue = {
  loc: (string | number)[];
  msg: string;
  type: string;
  ctx?: Record<string, unknown>;
};

export class ValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.loc.join(".")}: ${issue.msg}`).join("; "));
  }
}

export const MISSING = Symbol("missing");

export abstract class Schema<TOutput> {
  declare readonly __output: TOutput;

  abstract check(
    input: unknown,
    loc: (string | number)[],
    issues: ValidationIssue[],
  ): TOutput | typeof MISSING;

  parse(input: unknown, loc: (string | number)[] = []): TOutput {
    const issues: ValidationIssue[] = [];
    const value = this.check(input, loc, issues);

    if (issues.length > 0 || value === MISSING) {
      throw new ValidationError(issues);
    }

    return value;
  }

  optional(): Schema<TOutput | undefined> {
    return new OptionalSchema(this);
  }

  nullable(): Schema<TOutput | null> {
    return new NullableSchema(this);
  }

  default(fallback: TOutput): Schema<TOutput> {
    return new DefaultSchema(this, fallback);
  }

  refine(
    predicate: (value: TOutput) => boolean,
    message: string,
  ): Schema<TOutput> {
    return new RefinedSchema(this, predicate, message);
  }
}

export type Infer<TSchema extends Schema<unknown>> = TSchema["__output"];

function issue(
  issues: ValidationIssue[],
  loc: (string | number)[],
  type: string,
  msg: string,
  ctx?: Record<string, unknown>,
): typeof MISSING {
  issues.push(ctx ? { loc, msg, type, ctx } : { loc, msg, type });
  return MISSING;
}

export class StringSchema extends Schema<string> {
  constructor(
    private options: { min?: number; max?: number; pattern?: RegExp } = {},
  ) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    if (input === undefined) {
      return issue(issues, loc, "missing", "Field required");
    }

    if (typeof input !== "string") {
      return issue(issues, loc, "string_type", "Input should be a valid string");
    }

    const { min, max, pattern } = this.options;

    if (min !== undefined && input.length < min) {
      return issue(
        issues,
        loc,
        "string_too_short",
        `String should have at least ${min} characters`,
        { min_length: min },
      );
    }

    if (max !== undefined && input.length > max) {
      return issue(
        issues,
        loc,
        "string_too_long",
        `String should have at most ${max} characters`,
        { max_length: max },
      );
    }

    if (pattern && !pattern.test(input)) {
      return issue(
        issues,
        loc,
        "string_pattern_mismatch",
        `String should match pattern '${pattern.source}'`,
        { pattern: pattern.source },
      );
    }

    return input;
  }
}

export class IntSchema extends Schema<number> {
  constructor(private options: { min?: number; max?: number } = {}) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    if (input === undefined) {
      return issue(issues, loc, "missing", "Field required");
    }

    let value: number;

    if (typeof input === "number") {
      if (!Number.isInteger(input)) {
        return issue(
          issues,
          loc,
          "int_from_float",
          "Input should be a valid integer, got a number with a fractional part",
        );
      }

      value = input;
    } else if (typeof input === "string" && /^-?\d+$/.test(input.trim())) {
      value = Number(input.trim());
    } else {
      return issue(
        issues,
        loc,
        "int_parsing",
        "Input should be a valid integer, unable to parse string as an integer",
      );
    }

    const { min, max } = this.options;

    if (min !== undefined && value < min) {
      return issue(
        issues,
        loc,
        "greater_than_equal",
        `Input should be greater than or equal to ${min}`,
        { ge: min },
      );
    }

    if (max !== undefined && value > max) {
      return issue(
        issues,
        loc,
        "less_than_equal",
        `Input should be less than or equal to ${max}`,
        { le: max },
      );
    }

    return value;
  }
}

export class BooleanSchema extends Schema<boolean> {
  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    if (input === undefined) {
      return issue(issues, loc, "missing", "Field required");
    }

    if (typeof input === "boolean") {
      return input;
    }

    if (input === "true" || input === "1") {
      return true;
    }

    if (input === "false" || input === "0") {
      return false;
    }

    return issue(
      issues,
      loc,
      "bool_parsing",
      "Input should be a valid boolean",
    );
  }
}

export class LiteralSchema<TValue extends string> extends Schema<TValue> {
  constructor(private values: readonly TValue[]) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    if (input === undefined) {
      return issue(issues, loc, "missing", "Field required");
    }

    if (typeof input === "string" && this.values.includes(input as TValue)) {
      return input as TValue;
    }

    const expected = this.values.map((value) => `'${value}'`).join(", ");

    return issue(
      issues,
      loc,
      "literal_error",
      `Input should be ${expected}`,
      { expected },
    );
  }
}

export class DateTimeSchema extends Schema<Date> {
  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    if (input === undefined) {
      return issue(issues, loc, "missing", "Field required");
    }

    const date =
      typeof input === "string" && /^\d{4}-\d{2}-\d{2}T/.test(input)
        ? new Date(input)
        : null;

    if (!date || Number.isNaN(date.getTime())) {
      return issue(
        issues,
        loc,
        "datetime_parsing",
        "Input should be a valid ISO-8601 datetime",
      );
    }

    return date;
  }
}

export class ArraySchema<TItem> extends Schema<TItem[]> {
  constructor(
    private item: Schema<TItem>,
    private options: { min?: number; max?: number } = {},
  ) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    if (input === undefined) {
      return issue(issues, loc, "missing", "Field required");
    }

    if (!Array.isArray(input)) {
      return issue(issues, loc, "list_type", "Input should be a valid list");
    }

    const { min, max } = this.options;

    if (min !== undefined && input.length < min) {
      return issue(
        issues,
        loc,
        "too_short",
        `List should have at least ${min} items`,
        { min_length: min },
      );
    }

    if (max !== undefined && input.length > max) {
      return issue(
        issues,
        loc,
        "too_long",
        `List should have at most ${max} items`,
        { max_length: max },
      );
    }

    const before = issues.length;
    const values = input.map((item, index) =>
      this.item.check(item, [...loc, index], issues),
    );

    return issues.length > before ? MISSING : (values as TItem[]);
  }
}

type Shape = Record<string, Schema<unknown>>;

type ObjectOutput<TShape extends Shape> = {
  [K in keyof TShape as undefined extends Infer<TShape[K]>
    ? never
    : K]: Infer<TShape[K]>;
} & {
  [K in keyof TShape as undefined extends Infer<TShape[K]>
    ? K
    : never]?: Infer<TShape[K]>;
};

export class ObjectSchema<TShape extends Shape> extends Schema<ObjectOutput<TShape>> {
  constructor(readonly shape: TShape) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    if (input === undefined) {
      return issue(issues, loc, "missing", "Field required");
    }

    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return issue(
        issues,
        loc,
        "model_type",
        "Input should be a valid object",
      );
    }

    const before = issues.length;
    const output: Record<string, unknown> = {};

    for (const [key, schema] of Object.entries(this.shape)) {
      const value = schema.check(
        (input as Record<string, unknown>)[key],
        [...loc, key],
        issues,
      );

      if (value !== MISSING && value !== undefined) {
        output[key] = value;
      }
    }

    return issues.length > before
      ? MISSING
      : (output as ObjectOutput<TShape>);
  }

  extend<TMore extends Shape>(
    more: TMore,
  ): ObjectSchema<Omit<TShape, keyof TMore> & TMore> {
    return new ObjectSchema({ ...this.shape, ...more } as Omit<
      TShape,
      keyof TMore
    > &
      TMore);
  }

  partial(): ObjectSchema<{
    [K in keyof TShape]: Schema<Infer<TShape[K]> | undefined>;
  }> {
    return new ObjectSchema(
      Object.fromEntries(
        Object.entries(this.shape).map(([key, schema]) => [
          key,
          schema instanceof OptionalSchema ? schema : schema.optional(),
        ]),
      ),
    ) as never;
  }
}

export class OptionalSchema<TOutput> extends Schema<TOutput | undefined> {
  constructor(private inner: Schema<TOutput>) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    return input === undefined ? undefined : this.inner.check(input, loc, issues);
  }
}

export class NullableSchema<TOutput> extends Schema<TOutput | null> {
  constructor(private inner: Schema<TOutput>) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    return input === null ? null : this.inner.check(input, loc, issues);
  }
}

export class DefaultSchema<TOutput> extends Schema<TOutput> {
  constructor(
    private inner: Schema<TOutput>,
    private fallback: TOutput,
  ) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    return input === undefined
      ? this.fallback
      : this.inner.check(input, loc, issues);
  }
}

export class RefinedSchema<TOutput> extends Schema<TOutput> {
  constructor(
    private inner: Schema<TOutput>,
    private predicate: (value: TOutput) => boolean,
    private message: string,
  ) {
    super();
  }

  check(input: unknown, loc: (string | number)[], issues: ValidationIssue[]) {
    const value = this.inner.check(input, loc, issues);

    if (value === MISSING) {
      return MISSING;
    }

    return this.predicate(value)
      ? value
      : issue(issues, loc, "value_error", this.message);
  }
}

export const t = {
  string: (options?: { min?: number; max?: number; pattern?: RegExp }) =>
    new StringSchema(options),
  int: (options?: { min?: number; max?: number }) => new IntSchema(options),
  boolean: () => new BooleanSchema(),
  literal: <const TValue extends string>(values: readonly TValue[]) =>
    new LiteralSchema(values),
  datetime: () => new DateTimeSchema(),
  array: <TItem>(
    item: Schema<TItem>,
    options?: { min?: number; max?: number },
  ) => new ArraySchema(item, options),
  object: <TShape extends Shape>(shape: TShape) => new ObjectSchema(shape),
};
