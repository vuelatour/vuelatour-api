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

import { AircraftBalanceService } from './aircraft-balance.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { BalanceAvionPayload } from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  DIA,
  HASTA,
  V1,
  fakeSupabase,
  mundoLibros,
  type Fila,
} from './libros-pago-vendedor.fixture-spec';

/**
 * BALANCE POR AVIÓN + TACÓMETRO OMITIDO (15-oct-2026, invariante 79): el
 * tramo omitido se DICE en los pendientes del vuelo («… tramo X→Y con
 * tacómetro omitido por N (fecha): motivo — no suma horas») y la línea «sin
 * tacómetros — horas voladas vacías» sale SOLO si queda algún tramo del avión
 * sin lecturas que NO esté omitido. Ningún número cambia (un omitido aporta
 * 0 h: `num(null)`).
 */

const OMITIDO =
  ': tramo MID→CUN con tacómetro omitido por Itzi (2026-10-15 10:40): Falló el tacómetro — no suma horas';
const SIN_TACOS = ': sin tacómetros — horas voladas vacías';

const tramo = (over: Fila): Fila => ({
  vuelo_id: V1,
  aeronave_id: null,
  cancelada_at: null,
  taco_salida: null,
  taco_llegada: null,
  solo_operativa: false,
  es_ferry: false,
  es_sobrevuelo: false,
  tipo_parada: 'NORMAL',
  pasajeros: 3,
  fecha_salida_plan: `${DIA}T18:00:00+00:00`,
  vuelo: { fecha_vuelo: `${DIA}T15:00:00+00:00`, aeronave_id: AV },
  taco_omitido_at: null,
  taco_omitido_por: null,
  taco_omitido_motivo: null,
  ...over,
});

const regresoOmitido = tramo({
  id: 'e-2',
  orden: 2,
  origen_iata: 'MID',
  destino_iata: 'CUN',
  taco_salida: 102,
  taco_omitido_at: '2026-10-15T15:40:00Z',
  taco_omitido_por: 'u-itzi',
  taco_omitido_motivo: 'Falló el tacómetro',
});

/**
 * Sin la migración: cualquier select que NOMBRE `taco_omitido_*` responde
 * 42703 (como la BD real); el resto pasa al mini-PostgREST de los libros.
 */
function sinMigracion(sb: ReturnType<typeof fakeSupabase>['supabase']) {
  const from = (tabla: string) => {
    const q = sb.service.from(tabla) as Record<string, unknown>;
    const select = q.select as (c?: string) => unknown;
    q.select = (cols?: string) => {
      if (typeof cols === 'string' && cols.includes('taco_omitido')) {
        const error = {
          code: '42703',
          message: 'column escala.taco_omitido_at does not exist',
        };
        const err: Record<string, unknown> = {};
        for (const m of ['eq', 'in', 'is', 'order', 'limit', 'not', 'gte'])
          err[m] = () => err;
        err.maybeSingle = () => Promise.resolve({ data: null, error });
        err.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error }).then(res);
        return err;
      }
      return select(cols);
    };
    return q;
  };
  return { service: { from } };
}

async function libro(
  escalas: Fila[],
  opts: { migracion?: boolean } = {},
): Promise<{ p: BalanceAvionPayload; tablas: string[] }> {
  const m = mundoLibros();
  const { supabase, tablasLeidas } = fakeSupabase({
    ...m,
    escala: escalas,
    usuario: [{ id: 'u-itzi', nombre: 'Itzi' }],
  });
  const sb = opts.migracion === false ? sinMigracion(supabase) : supabase;
  let enviado: BalanceAvionPayload | undefined;
  const service = new AircraftBalanceService(
    sb as unknown as SupabaseService,
    {
      generateBalanceAvionXlsx: (p: BalanceAvionPayload) => {
        enviado = p;
        return Promise.resolve(Buffer.from('xlsx'));
      },
    } as never,
    { proximoServicio: () => null } as never,
    { oficialDetallePara: () => Promise.resolve(null) } as never,
    { resumenTiendita: () => Promise.resolve({ items: [] }) } as never,
  );
  await service.xlsx(AV, DESDE, HASTA);
  return { p: enviado!, tablas: tablasLeidas };
}

const delVuelo = (p: BalanceAvionPayload) =>
  p.pendientes.filter((x) => x.startsWith('Vuelo #501'));

describe('Balance por avión — tacómetro omitido (invariante 79)', () => {
  it('ida con lecturas + regreso omitido ⇒ la línea del omitido; sin «sin tacómetros»; las horas son las de la ida', async () => {
    const ida = mundoLibros().escala[0];
    const { p } = await libro([ida, regresoOmitido]);
    const pend = delVuelo(p);
    expect(pend.filter((x) => x.endsWith(OMITIDO))).toHaveLength(1);
    expect(pend.some((x) => x.endsWith(SIN_TACOS))).toBe(false);
    // Ningún número cambia: la fila vale lo mismo que sin el tramo omitido
    // (0 h, tacos 100→102, mismos importes).
    const sinRegreso = await libro([ida]);
    const fila = p.vuelos.find((v) => v.vuelo_id === V1);
    const filaSin = sinRegreso.p.vuelos.find((v) => v.vuelo_id === V1);
    // (Solo la RUTA cambia: el tramo existe — CUN-MID-CUN.)
    expect(fila?.ruta).toBe('CUN-MID-CUN');
    expect({ ...fila, ruta: null }).toEqual({ ...filaSin, ruta: null });
  });

  it('lo ÚNICO que falta está omitido ⇒ solo la línea del omitido (nunca «pendiente»)', async () => {
    const { p } = await libro([
      { ...regresoOmitido, orden: 1, taco_salida: null },
    ]);
    const pend = delVuelo(p);
    expect(pend.filter((x) => x.endsWith(OMITIDO))).toHaveLength(1);
    expect(pend.some((x) => x.endsWith(SIN_TACOS))).toBe(false);
  });

  it('omitido + OTRO tramo sin lecturas ⇒ las dos líneas', async () => {
    const { p } = await libro([
      tramo({
        id: 'e-1',
        orden: 1,
        origen_iata: 'CUN',
        destino_iata: 'MID',
        fecha_salida_plan: `${DIA}T15:00:00+00:00`,
      }),
      regresoOmitido,
    ]);
    const pend = delVuelo(p);
    expect(pend.filter((x) => x.endsWith(OMITIDO))).toHaveLength(1);
    expect(pend.filter((x) => x.endsWith(SIN_TACOS))).toHaveLength(1);
  });

  it('sin omitidos ⇒ ninguna lectura de nombres extra (cero consultas a usuario por esto)', async () => {
    const { p, tablas } = await libro([mundoLibros().escala[0]]);
    expect(p.pendientes.some((x) => x.includes('tacómetro omitido'))).toBe(
      false,
    );
    expect(tablas.filter((t) => t === 'usuario')).toHaveLength(0);
  });

  it('sin la migración ⇒ la consulta no nombra las columnas y el libro sale como siempre', async () => {
    const ida = { ...mundoLibros().escala[0] };
    const { p } = await libro([ida], { migracion: false });
    expect(p.vuelos.find((v) => v.vuelo_id === V1)).toBeDefined();
    expect(p.pendientes.some((x) => x.includes('tacómetro omitido'))).toBe(
      false,
    );
  });
});
