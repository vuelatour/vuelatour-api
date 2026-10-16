// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));

import { FlightReportService } from './flight-report.service';
import type { ReporteVueloPayload } from '../pyservices/pyservices.service';
import {
  fakeSupabase,
  type Row,
  type Tablas,
} from './taco-omitido.fixture-spec';

/**
 * REPORTE POR VUELO + TACÓMETRO OMITIDO (15-oct-2026, invariante 79): el
 * tramo omitido se DICE (nunca «pendiente»): `tramos[i]` gana los ADITIVOS
 * `taco_omitido`, `taco_omitido_motivo`, `taco_omitido_por_nombre` y
 * `taco_omitido_at` al final, `horas` sigue null (aporta 0 h) y
 * `notas_horas` gana UNA línea por tramo omitido.
 */
const V = 'v300';

function vuelo(): Row {
  return {
    id: V,
    folio: 300,
    cliente_id: null,
    aeronave_id: null,
    piloto_id: null,
    copiloto_id: null,
    tipo: 'CHARTER',
    estado: 'EN_VUELO',
    es_externo: false,
    origen_iata: 'CUN',
    destino_iata: 'CET',
    pasajeros: 1,
    fecha_vuelo: '2026-09-12T20:00:00+00:00',
    monto_total_usd: 1000,
    tc_usd_mxn: 20,
    tiempo_cobrable_hr: 1,
    subtotal_vuelo_usd: 1000,
    tuas_usd: 0,
    iva_usd: 0,
    iva_pct: 0,
    viaticos_pernocta_usd: 0,
    extras_total_usd: 0,
    ajuste_final_usd: 0,
    comision_vendedor_usd: 0,
    combinado_con_id: null,
    calculo_snapshot: null,
  };
}

const tramo = (over: Row): Row => ({
  vuelo_id: V,
  pasajeros: 1,
  pasajeros_nombres: [],
  solo_operativa: false,
  es_ferry: false,
  requiere_pernocta: false,
  aeronave_id: null,
  piloto_id: null,
  copiloto_id: null,
  cancelada_at: null,
  taco_omitido_at: null,
  taco_omitido_por: null,
  taco_omitido_motivo: null,
  ...over,
});

async function reporte(
  escalas: Row[],
  migracion = true,
): Promise<ReporteVueloPayload> {
  const db: Tablas = {
    vuelo: [vuelo()],
    escala: escalas,
    usuario: [{ id: 'u-itzi', nombre: 'Itzi' }],
    cobro_vuelo: [],
    gasto: [],
    vuelo_apoyo: [],
  };
  const { supabase } = fakeSupabase(db, { migracion });
  const service = new FlightReportService(supabase, {} as never);
  return (
    service as unknown as {
      buildPayload: (id: string) => Promise<ReporteVueloPayload>;
    }
  ).buildPayload(V);
}

describe('Reporte por vuelo — tacómetro omitido (invariante 79)', () => {
  const ida = tramo({
    id: 'e1',
    orden: 1,
    origen_iata: 'CUN',
    destino_iata: 'CET',
    taco_salida: 4454.8,
    taco_llegada: 4455.1,
  });
  const regreso = tramo({
    id: 'e2',
    orden: 2,
    origen_iata: 'CET',
    destino_iata: 'CUN',
    taco_salida: 4455.1,
    taco_llegada: null,
    taco_omitido_at: '2026-10-15T15:40:00Z',
    taco_omitido_por: 'u-itzi',
    taco_omitido_motivo: 'Falló el tacómetro',
  });

  it('aditivos AL FINAL del tramo, horas null y UNA línea en notas_horas', async () => {
    const r = await reporte([ida, regreso]);
    const [t1, t2] = r.tramos ?? [];
    expect(t2).toMatchObject({
      orden: 2,
      ruta: 'CET → CUN',
      horas: null,
      taco_omitido: true,
      taco_omitido_motivo: 'Falló el tacómetro',
      taco_omitido_por_nombre: 'Itzi',
      taco_omitido_at: '2026-10-15T15:40:00Z',
    });
    expect(Object.keys(t2).slice(-4)).toEqual([
      'taco_omitido',
      'taco_omitido_motivo',
      'taco_omitido_por_nombre',
      'taco_omitido_at',
    ]);
    expect(t1).toMatchObject({
      taco_omitido: false,
      taco_omitido_motivo: null,
      taco_omitido_por_nombre: null,
      taco_omitido_at: null,
    });
    expect(r.notas_horas).toContain(
      'Tramo 2 (CET → CUN): tacómetro omitido por Itzi (2026-10-15 10:40): Falló el tacómetro — sus horas no se contaron.',
    );
    // Las horas voladas son SOLO las del tramo con lecturas (0.3 h).
    expect(r.horas_voladas_hr).toBe(0.3);
  });

  it('sin omitidos ⇒ ninguna línea nueva en notas_horas', async () => {
    const r = await reporte([ida]);
    expect(
      (r.notas_horas ?? []).some((n) => n.includes('tacómetro omitido')),
    ).toBe(false);
  });

  it('sin la migración ⇒ la consulta no nombra las columnas y taco_omitido=false', async () => {
    const sinCols = (e: Row): Row => {
      const c = { ...e };
      delete c.taco_omitido_at;
      delete c.taco_omitido_por;
      delete c.taco_omitido_motivo;
      return c;
    };
    const r = await reporte([sinCols(ida)], false);
    expect(r.tramos?.[0]).toMatchObject({
      taco_omitido: false,
      taco_omitido_por_nombre: null,
    });
  });
});
