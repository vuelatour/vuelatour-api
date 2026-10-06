// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('./aircraft.service', () => ({ AircraftService: class {} }));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));

import { BadRequestException } from '@nestjs/common';
import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type {
  BalanceAvionPayload,
  BalanceGeneralPayload,
} from '../pyservices/pyservices.service';
import { MENSAJE_MODO_BALANCE_INVALIDO } from './balance-general-modo.util';
import {
  AV,
  DESDE,
  HASTA,
  INGRESOS_LIBROS,
  fakeSupabase,
  mundoLibros,
} from './libros-pago-vendedor.fixture-spec';

/**
 * «Balance mensual» / «Balance general» (6-oct-2026, API 0.0.64). Contrato:
 * `xlsxGeneral(desde, hasta, modo)` manda `variante = modo` a pyservices
 * (default 'mensual') y es lo ÚNICO que cambia entre los dos libros: el
 * payload se arma igual, sin un número distinto. Un modo inválido es 400
 * ANTES de leer la BD o llamar a pyservices.
 */

function armar() {
  const f = fakeSupabase(mundoLibros(INGRESOS_LIBROS));
  const generales: BalanceGeneralPayload[] = [];
  const individuales: BalanceAvionPayload[] = [];
  const service = new AircraftBalanceService(
    f.supabase as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        individuales.push(p);
        return Promise.resolve(Buffer.from('xlsx'));
      },
      generateBalanceGeneralXlsx: (p: BalanceGeneralPayload) => {
        generales.push(p);
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    {
      oficialDetallePara: (dia: string) =>
        Promise.resolve({ tc: 25, fecha_dato: dia, fuente: 'OPEN_ER_API' }),
    } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  return { service, generales, individuales, tablasLeidas: f.tablasLeidas };
}

/** Llaves del payload ANTES del 0.0.64, en su orden. */
const LLAVES_PREVIAS = [
  'generado',
  'periodo_desde',
  'periodo_hasta',
  'resumen',
  'resumen_totales',
  'consolidado',
  'aviones',
  'gastos_empresa',
  'inventario',
  'empresa',
];

/**
 * El payload serializado sin lo que cambia entre corridas (los sellos
 * `generado`, también el del consolidado, que lleva milisegundos) ni la
 * variante.
 */
const sinSelloNiVariante = (p: BalanceGeneralPayload) =>
  JSON.stringify(p, (llave: string, valor: unknown) =>
    llave === 'generado' || llave === 'variante' ? null : valor,
  );

describe('Balance general — `modo` ⇒ `variante` del payload (6-oct-2026, API 0.0.64)', () => {
  it('sin modo ⇒ «Balance mensual»: variante mensual y el resultado lo dice', async () => {
    const { service, generales } = armar();
    const r = await service.xlsxGeneral(DESDE, HASTA);
    expect(r).toEqual({
      buffer: Buffer.from('xlsx'),
      desde: DESDE,
      hasta: HASTA,
      modo: 'mensual',
    });
    expect(generales).toHaveLength(1);
    expect(generales[0].variante).toBe('mensual');
  });

  it('`undefined` explícito (el controlador sin DTO) también es mensual', async () => {
    const { service, generales } = armar();
    const r = await service.xlsxGeneral(DESDE, HASTA, undefined);
    expect(r.modo).toBe('mensual');
    expect(generales[0].variante).toBe('mensual');
  });

  it('modo general ⇒ variante general', async () => {
    const { service, generales } = armar();
    const r = await service.xlsxGeneral(DESDE, HASTA, 'general');
    expect(r.modo).toBe('general');
    expect(r.desde).toBe(DESDE);
    expect(r.hasta).toBe(HASTA);
    expect(generales[0].variante).toBe('general');
  });

  it('mensual y general mandan EXACTAMENTE el mismo payload salvo `variante` (ningún número cambia)', async () => {
    const a = armar();
    await a.service.xlsxGeneral(DESDE, HASTA, 'mensual');
    const b = armar();
    await b.service.xlsxGeneral(DESDE, HASTA, 'general');
    const mensual = a.generales[0];
    const general = b.generales[0];
    // El mundo trae dinero de verdad: la comparación no es entre vacíos.
    expect(mensual.consolidado.vuelos.length).toBeGreaterThan(0);
    expect(mensual.resumen_totales.venta_mxn).toBeGreaterThan(0);
    // Byte a byte (mismo orden de llaves) fuera del sello y la variante.
    expect(sinSelloNiVariante(general)).toBe(sinSelloNiVariante(mensual));
    // Y las mismas tablas leídas, en el mismo orden: ninguna consulta extra.
    expect(b.tablasLeidas).toEqual(a.tablasLeidas);
  });

  it('`variante` es ADITIVA: va al final y lo de antes es prefijo exacto', async () => {
    const { service, generales } = armar();
    await service.xlsxGeneral(DESDE, HASTA, 'general');
    expect(Object.keys(generales[0])).toEqual([...LLAVES_PREVIAS, 'variante']);
  });

  it('otro modo ⇒ 400 con el texto es-MX, ANTES de leer la BD o llamar a pyservices', async () => {
    for (const modo of ['anual', 'GENERAL', ' general', '', null, 1]) {
      const { service, generales, tablasLeidas } = armar();
      const intento = service.xlsxGeneral(DESDE, HASTA, modo as never);
      await expect(intento).rejects.toBeInstanceOf(BadRequestException);
      await expect(intento).rejects.toThrow(MENSAJE_MODO_BALANCE_INVALIDO);
      expect(tablasLeidas).toEqual([]);
      expect(generales).toEqual([]);
    }
  });

  it('el periodo se sigue validando igual (con modo general también)', async () => {
    const { service, generales } = armar();
    await expect(
      service.xlsxGeneral('2026-09-30', '2026-09-01', 'general'),
    ).rejects.toThrow('desde no puede ser posterior a hasta');
    await expect(
      service.xlsxGeneral('30-09-2026', HASTA, 'general'),
    ).rejects.toThrow('desde/hasta deben ser YYYY-MM-DD');
    expect(generales).toEqual([]);
  });

  it('el libro de UN avión no cambia: su payload no lleva `variante`', async () => {
    const { service, individuales } = armar();
    await service.xlsx(AV, DESDE, HASTA);
    expect(individuales).toHaveLength(1);
    expect(Object.keys(individuales[0])).not.toContain('variante');
  });
});
