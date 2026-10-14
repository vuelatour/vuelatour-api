import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';

/**
 * REPORTE POR VUELO con el K de los libros (revisión del lote 2,
 * 14-oct-2026, invariante 73): `TipoCambioService` entra a
 * `FlightReportService` como 3.er parámetro @Optional. Sin el import del
 * módulo, Nest no falla: el reporte «funciona» pero SIN el T.C. oficial de
 * respaldo (un pago al vendedor en pesos sin T.C. de un vuelo sin T.C. en la
 * cotización deja de restarse aquí y sí se resta en los libros). Este spec
 * congela el import leyendo el FUENTE (cargar `FlightsModule` arrastra el
 * guard de auth con `jose` en ESM, que jest no transforma).
 */
describe('FlightsModule', () => {
  const fuente = readFileSync(
    path.resolve(__dirname, 'flights.module.ts'),
    'utf8',
  );
  const bloqueImports = /imports:\s*\[([\s\S]*?)\],\s*controllers:/.exec(
    fuente,
  );

  it('importa TipoCambioModule (el T.C. oficial del día de la cotización)', () => {
    expect(fuente).toContain(
      "import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';",
    );
    expect(bloqueImports).not.toBeNull();
    expect(bloqueImports?.[1]).toMatch(/^\s*TipoCambioModule,$/m);
  });

  it('TipoCambioModule no importa nada (sin ciclo con flights)', () => {
    const imports = (Reflect.getMetadata('imports', TipoCambioModule) ??
      []) as unknown[];
    expect(imports).toEqual([]);
  });
});
