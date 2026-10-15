// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));

import { Logger } from '@nestjs/common';
import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { ConciliacionService } from '../conciliacion/conciliacion.service';

/**
 * PRE-CIERRE · COBROS BANCARIOS SIN CONCILIAR con los PARCIALES (14-oct-2026,
 * API 0.0.78, invariante 77, D14). «Cobros sin banco» ya cuenta un cobro con
 * abonos que no lo cubren (caso real: #315 de Beh Kay, $3,400 con un SPEI de
 * $1,700): el renglón lo trae en `count`, gana `parciales` en la raíz y
 * `parcial`/`faltante`/`monto_vinculado` por cobro (de `cobrosSinBanco`,
 * sin otra lectura), y el detalle explica qué es un parcial SOLO si hay
 * alguno (sin parciales, el texto de siempre). Sigue sin bloquear el cierre.
 * Fake: BD vacía (cualquier consulta responde []).
 */
type Fila = Record<string, unknown>;

function bdVacia(): SupabaseService {
  const consulta = (): unknown => {
    const q: Record<string | symbol, unknown> = {};
    const proxy: unknown = new Proxy(q, {
      get(_t, prop) {
        if (prop === 'then') {
          return (
            res: (v: unknown) => unknown,
            rej?: (e: unknown) => unknown,
          ) =>
            Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => Promise.resolve({ data: null, error: null });
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return { service: { from: () => consulta() } } as unknown as SupabaseService;
}

function armar(cobrosSinBanco: unknown) {
  const conc = {
    cobrosSinBanco: jest.fn().mockResolvedValue(cobrosSinBanco),
  } as unknown as ConciliacionService;
  const nada = {} as never;
  return new ProfitSharingService(bdVacia(), nada, nada, conc);
}

const PERIODO = { desde: '2026-09-01', hasta: '2026-09-30' };
const CLAVE = 'cobros_bancarios_sin_conciliar';
const DETALLE =
  'Transferencia, HSBC link, cheque o Paywise sin cruzar con ningún abono importado: importa el estado de cuenta (o el de Paywise → Auditoría Paywise) y concilia. Un cobro que nunca llegó al banco es dinero que se cree cobrado.';

interface Respuesta {
  listo: boolean;
  items: Fila[];
}

/** Una fila de `cobrosSinBanco` (con los aditivos del 0.0.78). */
const fila = (extra: Fila): Fila => ({
  tipo: 'COBRO_VUELO',
  id: 'c',
  folio: 1,
  grupo_folio: null,
  fecha_cobro: '2026-09-15T17:00:00Z',
  monto: 0,
  moneda: 'MXN',
  metodo_cobro: 'TRANSFERENCIA',
  neto: 0,
  parcial: false,
  monto_vinculado: 0,
  faltante: 0,
  abonos_n: 0,
  abonos: [],
  ...extra,
});

describe('ProfitSharingService.preCierre — cobros bancarios sin conciliar con PARCIALES', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('#315 parcial (faltan $1,700) + #317 libre: count 2, parciales 1, faltante por cobro y el detalle que explica el parcial; no bloquea', async () => {
    const svc = armar({
      data: [
        fila({
          id: 'c315',
          folio: 315,
          monto: 3400,
          neto: 3400,
          parcial: true,
          monto_vinculado: 1700,
          faltante: 1700,
          abonos_n: 1,
        }),
        fila({
          id: 'c317',
          folio: 317,
          monto: 500,
          neto: 500,
          faltante: 500,
        }),
      ],
      total: 2,
      parciales: 1,
      por_moneda: [{ moneda: 'MXN', monto: 3900, faltante: 2200 }],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    const item = r.items.find((x) => x.clave === CLAVE)!;
    expect(item).toMatchObject({
      count: 2,
      parciales: 1,
      detalle: `${DETALLE} Un cobro «parcial» ya tiene parte en el banco: falta vincular el resto.`,
      por_moneda: [{ moneda: 'MXN', monto: 3900, faltante: 2200 }],
    });
    expect(item.cobros).toEqual([
      {
        tipo: 'COBRO_VUELO',
        id: 'c315',
        folio: 315,
        grupo_folio: null,
        fecha_cobro: '2026-09-15T17:00:00Z',
        monto: 3400,
        moneda: 'MXN',
        metodo_cobro: 'TRANSFERENCIA',
        parcial: true,
        faltante: 1700,
        monto_vinculado: 1700,
      },
      {
        tipo: 'COBRO_VUELO',
        id: 'c317',
        folio: 317,
        grupo_folio: null,
        fecha_cobro: '2026-09-15T17:00:00Z',
        monto: 500,
        moneda: 'MXN',
        metodo_cobro: 'TRANSFERENCIA',
        parcial: false,
        faltante: 500,
        monto_vinculado: 0,
      },
    ]);
    expect(r.listo).toBe(true);
  });

  it('sin parciales: el detalle de siempre y parciales 0', async () => {
    const svc = armar({
      data: [fila({ id: 'c317', monto: 500, faltante: 500 })],
      total: 1,
      parciales: 0,
      por_moneda: [{ moneda: 'MXN', monto: 500, faltante: 500 }],
    });
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(r.items.find((x) => x.clave === CLAVE)).toMatchObject({
      count: 1,
      parciales: 0,
      detalle: DETALLE,
    });
  });

  it('«Cobros sin banco» caído: count 0, parciales 0 y el detalle de siempre (best-effort, como hoy)', async () => {
    const conc = {
      cobrosSinBanco: jest.fn().mockRejectedValue(new Error('caída')),
    } as unknown as ConciliacionService;
    const nada = {} as never;
    const svc = new ProfitSharingService(bdVacia(), nada, nada, conc);
    const r = (await svc.preCierre(PERIODO)) as unknown as Respuesta;
    expect(r.items.find((x) => x.clave === CLAVE)).toMatchObject({
      count: 0,
      parciales: 0,
      cobros: [],
      detalle: DETALLE,
    });
  });
});
