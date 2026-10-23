
type CamelCase<TKey extends string> = TKey extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : TKey;

export type CamelKeys<TObject> = {
  [TKey in keyof TObject as TKey extends string
    ? CamelCase<TKey>
    : TKey]: TObject[TKey];
};

export function camelKeys<TObject extends object>(
  input: TObject,
): CamelKeys<TObject> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  ) as CamelKeys<TObject>;
}
