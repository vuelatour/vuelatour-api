import { Transform } from 'class-transformer';

/**
 * Booleano de query string SIN el bug de `@Type(() => Boolean)`
 * (Boolean('false') === true invierte el filtro): 'true'/'false' se mapean
 * explícitamente y cualquier otro valor pasa intacto para que `@IsBoolean()`
 * lo rechace con 400 en lugar de adivinar.
 */
export function ToBooleanQuery(): PropertyDecorator {
  return Transform(({ value }): unknown =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  );
}
