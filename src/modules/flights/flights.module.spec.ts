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

  /**
   * CONFIRMAR desde el detalle (16-oct-2026, invariante 85): FlightsService
   * recibe `QuotesService.confirm` por el token CONFIRMADOR_COTIZACION. Es un
   * ciclo REAL de módulos (QuotesModule ya importaba FlightsModule), así que
   * los DOS lados van con forwardRef y QuotesModule provee y exporta el
   * token; `flights.service` sigue sin importar `quotes.service` en runtime.
   */
  describe('ciclo flights ↔ quotes para confirmar un COTIZADO', () => {
    const fuenteQuotes = readFileSync(
      path.resolve(__dirname, '../quotes/quotes.module.ts'),
      'utf8',
    );
    const fuenteService = readFileSync(
      path.resolve(__dirname, 'flights.service.ts'),
      'utf8',
    );

    it('FlightsModule importa QuotesModule con forwardRef', () => {
      expect(bloqueImports?.[1]).toMatch(
        /^\s*forwardRef\(\(\) => QuotesModule\),$/m,
      );
    });

    it('QuotesModule importa FlightsModule con forwardRef y provee/exporta CONFIRMADOR_COTIZACION', () => {
      expect(fuenteQuotes).toMatch(/forwardRef\(\(\) => FlightsModule\),/);
      expect(fuenteQuotes).toMatch(
        /\{\s*provide:\s*CONFIRMADOR_COTIZACION,\s*useExisting:\s*QuotesService\s*\}/,
      );
      expect(fuenteQuotes).toMatch(
        /exports:\s*\[QuotesService,\s*CONFIRMADOR_COTIZACION\]/,
      );
    });

    it('flights.service NO importa quotes.service en runtime (solo `import type`)', () => {
      const lineas = fuenteService
        .split('\n')
        .filter((l) => l.includes("from '../quotes/quotes.service'"));
      expect(lineas.length).toBeGreaterThan(0);
      for (const l of lineas) expect(l).toMatch(/^import type /);
    });
  });
});
