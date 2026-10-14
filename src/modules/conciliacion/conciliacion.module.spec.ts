import { ConciliacionModule } from './conciliacion.module';
import { TipoCambioModule } from '../tipo-cambio/tipo-cambio.module';

/**
 * CRUCE USD (13-oct-2026, invariante 70): `TipoCambioService` entra a
 * conciliación como 6.º parámetro @Optional. Sin el import del módulo, Nest
 * no falla: todo «funciona» pero SIN T.C. oficial (el cruce USD queda
 * AMBIGUO y el pre-cierre en lectura_fallida). Este spec congela el import y
 * que no haya ciclo.
 */
describe('ConciliacionModule', () => {
  it('importa TipoCambioModule (el T.C. oficial del día del cargo)', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ConciliacionModule,
    ) as unknown[];
    expect(imports).toContain(TipoCambioModule);
  });

  it('TipoCambioModule no importa nada (sin ciclo con conciliación)', () => {
    const imports = (Reflect.getMetadata('imports', TipoCambioModule) ??
      []) as unknown[];
    expect(imports).toEqual([]);
  });
});
