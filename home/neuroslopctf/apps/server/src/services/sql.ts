export function lit(value: string | number | boolean | Date | null): string {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Not a finite number: ${value}`);
    }

    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (value instanceof Date) {
    return `'${value.toISOString()}'::timestamptz`;
  }

  return `'${value.replaceAll("'", "''")}'`;
}
