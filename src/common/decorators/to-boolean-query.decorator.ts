import { Transform } from 'class-transformer';

/**
 * Booleano de query string SIN el bug de `Boolean('false') === true`.
 *
 * El ValidationPipe global corre con `enableImplicitConversion: true`, y
 * class-transformer aplica esa conversión implícita (`Boolean(value)`) ANTES
 * de los `@Transform`: con `?conciliado=false` el decorador recibía ya `true`
 * y el filtro se invertía (5-oct-2026: la pestaña «Pendientes» de
 * Conciliación mostraba los conciliados). Por eso se lee el valor CRUDO del
 * objeto de origen (`obj[key]`, la query tal cual llegó) y no `value`.
 * 'true'/'false' se mapean explícitamente —y, desde el 6-oct-2026, también
 * '1'/'0' (el panel manda `incluir_no_bancarios=1`)—; cualquier otro valor
 * pasa intacto para que `@IsBoolean()` lo rechace con 400 en lugar de
 * adivinar.
 */
export function ToBooleanQuery(): PropertyDecorator {
  return Transform(({ obj, key, value }): unknown => {
    const fuente = obj as Record<string | symbol, unknown> | null | undefined;
    const crudo: unknown =
      fuente && typeof fuente === 'object' && key in fuente
        ? fuente[key]
        : (value as unknown);
    if (crudo === 'true' || crudo === '1' || crudo === true) return true;
    if (crudo === 'false' || crudo === '0' || crudo === false) return false;
    return crudo;
  });
}
