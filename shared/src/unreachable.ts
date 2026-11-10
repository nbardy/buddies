/**
 * The `default` of a switch that already handles every variant of a union. TypeScript rejects
 * the call when a variant is unhandled (its argument is then not `never`), and a value from
 * outside the type fails loudly instead of rendering as nothing. It also tells linters that see
 * no types (Biome's useIterableCallbackReturn) that every path returns.
 */
export function unreachable(value: never): never {
  throw new Error(`Unreachable variant: ${JSON.stringify(value)}`);
}
