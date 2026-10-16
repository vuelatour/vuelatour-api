// INICIO OFICIAL (16-oct-2026, invariante 86): lista/Excel por
// `fecha_emision`, «Por facturar» y su conteo por `fecha_vuelo`;
// `vuelos-candidatos` sin piso.
jest.mock('../realtime/notifications.service', () => ({
  NotificationsService: class {},
}));
jest.mock('../flights/flights.service', () => ({ FlightsService: class {} }));

import { FacturasEmitidasService } from './facturas-emitidas.service';
import type { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  cfgInicio,
  supabaseGrabador,
} from '../../common/inicio-oficial.fixture-spec';

const INICIO = '2026-09-01';
const PISO = 'fecha_vuelo.is.null,fecha_vuelo.gte.2026-09-01T00:00:00-05:00';

type Priv = {
  filtrosDe(q: object, inicio: string | null): { desde?: string };
  vuelosConSolicitud<T>(cols: string, inicio?: string | null): Promise<T[]>;
};

function armar(inicio: string | null) {
  const g = supabaseGrabador();
  const solicitud = {
    ligadasDeVuelos: jest.fn().mockResolvedValue(new Map()),
    exigenciasDeAutomaticas: jest.fn().mockResolvedValue(new Map()),
  };
  const svc = new FacturasEmitidasService(
    g.supabase,
    {} as never,
    solicitud as never,
    {} as never,
    {} as never,
    cfgInicio(inicio) as unknown as ConfiguracionService,
  );
  return { svc, priv: svc as unknown as Priv, ...g };
}

describe('FacturasEmitidasService — inicio oficial', () => {
  it('filtros de lista y Excel: el desde sube al inicio', () => {
    const { priv } = armar(INICIO);
    expect(priv.filtrosDe({}, INICIO).desde).toBe(INICIO);
    expect(priv.filtrosDe({ desde: '2026-08-01' }, INICIO).desde).toBe(INICIO);
    expect(priv.filtrosDe({ desde: '2026-09-20' }, INICIO).desde).toBe(
      '2026-09-20',
    );
    expect(priv.filtrosDe({}, null).desde).toBeUndefined();
  });

  it('con vuelo_id NO hay piso (facturas de UN vuelo abierto por id)', () => {
    const { priv } = armar(INICIO);
    expect(priv.filtrosDe({ vuelo_id: 'v-201' }, INICIO).desde).toBeUndefined();
    expect(
      priv.filtrosDe({ vuelo_id: 'v-201', desde: '2026-08-01' }, INICIO).desde,
    ).toBe('2026-08-01');
  });

  it('vuelos con solicitud: con inicio lleva el or; sin él (candidatos) no', async () => {
    const { priv, de, lleva } = armar(INICIO);
    await priv.vuelosConSolicitud('id', INICIO);
    await priv.vuelosConSolicitud('id');
    const [conPiso, sinPiso] = de('vuelo');
    expect(lleva(conPiso, 'or', PISO)).toBe(true);
    expect(sinPiso.ops.some((o) => o.m === 'or')).toBe(false);
  });

  it('conteo del badge y bandeja «Por facturar» pasan el inicio', async () => {
    const { svc, de, lleva } = armar(INICIO);
    await svc.conteoPorFacturar().catch(() => undefined);
    await svc.porFacturar().catch(() => undefined);
    const vuelos = de('vuelo').filter((c) =>
      c.ops.some((o) => o.m === 'not' && o.args[0] === 'factura_solicitada_at'),
    );
    expect(vuelos.length).toBeGreaterThanOrEqual(2);
    for (const c of vuelos) expect(lleva(c, 'or', PISO)).toBe(true);
  });
});

// ===== Auditoría 16-oct-2026 (API 0.0.85): resumen del registro =====

describe('FacturasEmitidasService.resumenDe — inicio oficial (0.0.85)', () => {
  type ResumenPriv = {
    resumenDe(
      facturas: object[],
      ligas: object[],
      calc: object,
      emisoras: object[],
      porFacturar: number,
      inicio: string | null,
    ): Record<string, unknown>;
  };
  const f = (id: string, folio: number, fecha: string, extra = {}) => ({
    id,
    serie: 'A',
    folio: String(folio),
    folio_num: folio,
    fecha_emision: fecha,
    estatus: 'VIGENTE',
    moneda: 'MXN',
    total: 100,
    emisora_id: 'e1',
    pdf_path: 'x.pdf',
    ...extra,
  });
  // A-0395 del 31-ago (fuera del conteo), A-0397 del 2-sep y A-0398: el
  // hueco 0396 SOLO existe mirando la serie completa.
  const facturas = [
    f('f395', 395, '2026-08-31'),
    f('f397', 397, '2026-09-02'),
    f('f398', 398, '2026-09-20', { pdf_path: null }),
  ];
  const calc = {
    porFactura: new Map(),
    vuelosDuplicados: new Set(['v-ago', 'v-sep']),
    vigentesPorVuelo: new Map([
      ['v-ago', ['f395']],
      ['v-sep', ['f397', 'f398']],
    ]),
    detalle: new Map(),
  };
  const res = (inicio: string | null) =>
    (armar(inicio).priv as unknown as ResumenPriv).resumenDe(
      facturas,
      [],
      calc,
      [{ id: 'e1', razon_social: 'VT' }],
      3,
      inicio,
    );

  it('conteos y totales desde el inicio; huecos sobre TODA la serie; aditivo desde', () => {
    const r = res(INICIO);
    expect(r.registradas).toBe(2);
    expect(r.vigentes).toBe(2);
    expect(r.sin_pdf).toBe(1);
    expect(r.vuelos_con_varias).toBe(1);
    expect(r.totales_vigentes).toEqual([
      expect.objectContaining({ moneda: 'MXN', total: 200 }),
    ]);
    const huecos = r.huecos as Array<{ faltantes: unknown[] }>;
    expect(huecos).toHaveLength(1);
    expect(huecos[0].faltantes).toEqual(['A-396']);
    expect(r.desde).toBe(INICIO);
  });

  it('inicio null ⇒ todo el registro (como 0.0.84) y desde null', () => {
    const r = res(null);
    expect(r.registradas).toBe(3);
    expect(r.vuelos_con_varias).toBe(2);
    expect(r.desde).toBeNull();
  });
});
