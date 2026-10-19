// Dependencias de inyección que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../tipo-cambio/tipo-cambio.service', () => ({
  TipoCambioService: class {},
  fuenteTcLegible: (f: string | null | undefined) =>
    f === 'OPEN_ER_API' ? 'open.er-api' : (f ?? 'TC oficial'),
}));
jest.mock('../conciliacion/conciliacion.service', () => ({
  ConciliacionService: class {},
}));
jest.mock('../inventory/inventory.service', () => ({
  InventoryService: class {},
}));
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));

import { ProfitSharingService } from './profit-sharing.service';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  AV,
  DESDE,
  HASTA,
  INGRESOS_LIBROS,
  fakeSupabase,
  mundoLibros,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';

/**
 * REPARTO A SOCIOS — INGRESO ASIGNADO A UN AVIÓN (13-oct-2026, API 0.0.75,
 * invariante 67). Un ingreso de RESULTADO registrado en Ingresos con ESTE
 * avión (y `fecha` en el periodo) SUMA al saldo, neto de su comisión
 * bancaria: USD ⇒ el neto; MXN ⇒ neto ÷ (T.C. propio ?? oficial del día del
 * ingreso). Sin T.C. NO suma (`otros_ingresos_avion_sin_tc_mxn`). De ahí el
 * reparto, las utilidades por mes y la cuenta corriente.
 *
 * Mundo de los libros (#501 de XB-TST, K 20; sin pago al vendedor): saldo
 * base = 1,793.72 − 15.70 de comisión bancaria = 1,778.02 (el GAS sin T.C.
 * no convierte sin oficial; con oficial 18 sí resta: ver cada caso).
 *
 * Desde el 0.0.77 (decisión del cliente del 14-oct-2026) la conversión es la
 * fuente ÚNICA `usdDeIngresoAvion` —la MISMA del balance y del tablero— y la
 * línea de detalle trae `tc_origen` (PROPIO | GASTO_LIGADO |
 * OFICIAL_DEL_DIA | null) AL FINAL. Un REEMBOLSO_DEVOLUCION ligado (`gasto_id`)
 * a un gasto en pesos que ESTE avión resta usa el divisor de ese gasto
 * (`tc_gasto` ?? oficial del día del GASTO): se anulan exactos.
 */

const AV2 = 'av-2';
const MAU = 'u-mau';
const ACC = 'u-acc';
const r2 = (x: number) => Math.round(x * 100) / 100;

const ING_AVION: Fila = {
  id: 'i-av',
  folio: 14,
  categoria: 'REEMBOLSO_DEVOLUCION',
  fecha: '2026-09-04',
  descripcion: 'TRANSF INTERBANCARIA SPEI',
  monto: 46550.8,
  comision_monto: null,
  moneda: 'MXN',
  tc_usd_mxn: null,
  pagador: 'angel alvarez',
  aeronave_id: AV,
  aeronave: { matricula: 'XB-TST', color_calendario: '#3B82F6' },
  cuenta: { alias: 'EJE SCOTIA', banco: 'Scotiabank' },
  notas: null,
  deleted_at: null,
  cliente: null,
  vuelo: null,
};

/** El mundo de los libros con lo que lee el reparto (aviones activos y socios). */
function mundoReparto(ingresos: Fila[] = []): Record<string, Fila[]> {
  const m = mundoLibros(ingresos);
  return {
    ...m,
    aeronave: [
      ...m.aeronave.map((a) => ({ ...a, activa: true })),
      { ...m.aeronave[0], id: AV2, matricula: 'XB-DOS', activa: true },
    ],
    aeronave_socio: [
      {
        aeronave_id: AV,
        socio_id: MAU,
        porcentaje: '71.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
      {
        aeronave_id: AV,
        socio_id: ACC,
        porcentaje: '29.000',
        vigente_desde: '2020-01-01',
        vigente_hasta: null,
      },
    ],
    usuario: [
      { id: MAU, nombre: 'Mauricio Roque' },
      { id: ACC, nombre: 'Aero Charter Cancun S.A. de C.V.' },
    ],
    reserva_overhaul: [],
  };
}

/**
 * Servicio sobre el mundo; `tcOficial` null = sin dato oficial; un mapa =
 * el oficial POR DÍA (los días que no están: sin dato).
 */
function armar(
  mundo: Record<string, Fila[]>,
  tcOficial: number | null | Record<string, number> = null,
  opts: { sinMigracion?: boolean } = {},
) {
  const f = fakeSupabase(mundo, opts);
  const diasOficiales: string[] = [];
  const tcDe = (dia: string): number | null =>
    tcOficial == null
      ? null
      : typeof tcOficial === 'number'
        ? tcOficial
        : (tcOficial[dia] ?? null);
  const svc = new ProfitSharingService(
    f.supabase as unknown as SupabaseService,
    {} as never,
    {
      oficialDetallePara: (dia: string) => {
        diasOficiales.push(dia);
        const tc = tcDe(dia);
        return Promise.resolve(
          tc == null ? null : { tc, fecha_dato: dia, fuente: 'OPEN_ER_API' },
        );
      },
    } as never,
    {} as never,
  );
  return { svc, diasOficiales, tablas: f.tablasLeidas };
}

async function compute(
  mundo: Record<string, Fila[]>,
  tcOficial: number | null = null,
  q: { aeronave_id?: string } = {},
) {
  const { svc } = armar(mundo, tcOficial);
  return svc.compute({ desde: DESDE, hasta: HASTA, ...q });
}

const avionDe = (r: Awaited<ReturnType<typeof compute>>, id: string = AV) => {
  const a = r.aviones.find((x) => x.aeronave.id === id);
  if (!a) throw new Error(`sin avión ${id}`);
  return a;
};

/** Rutas (a.b.0.c) donde dos resultados difieren. */
function diferencias(a: unknown, b: unknown, ruta = ''): string[] {
  if (Object.is(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...claves].flatMap((k) =>
      diferencias(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        ruta ? `${ruta}.${k}` : k,
      ),
    );
  }
  return [ruta];
}

describe('Reparto a socios — otros ingresos del avión (invariante 67)', () => {
  it('(a) ING MXN 46,550.80 con oficial 18 ⇒ +2,586.16 al saldo al centavo; Σ reparto == saldo; detalle con el T.C. oficial', async () => {
    const sin = avionDe(await compute(mundoReparto(), 18));
    const r = await compute(mundoReparto([ING_AVION]), 18);
    const a = avionDe(r);
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(2586.16);
    expect(a.saldo_disponible_usd).toBe(r2(sin.saldo_disponible_usd + 2586.16));
    // La venta NO se mezcla.
    expect(a.ingresos.cobrado_usd).toBe(sin.ingresos.cobrado_usd);
    expect(r2(a.reparto.reduce((s, x) => s + x.monto_usd, 0))).toBe(
      a.saldo_disponible_usd,
    );
    expect(a.detalle.otros_ingresos_avion).toEqual([
      {
        id: 'i-av',
        clave: 'ING-14',
        fecha: '2026-09-04',
        categoria: 'REEMBOLSO_DEVOLUCION',
        categoria_etiqueta: 'Reembolsos y devoluciones recibidos',
        concepto: 'TRANSF INTERBANCARIA SPEI · angel alvarez',
        moneda: 'MXN',
        monto: 46550.8,
        comision: null,
        neto: 46550.8,
        usd: 2586.16,
        // ADITIVO (0.0.94, invariante 92): el neto EN PESOS.
        mxn: 46550.8,
        tc: 18,
        tc_oficial: true,
        // ADITIVO al final (0.0.77): de dónde salió el T.C.
        tc_origen: 'OFICIAL_DEL_DIA',
        // ADITIVO al final (revisión del 14-oct-2026): sin gasto ligado, sin aviso.
        tc_aviso: null,
      },
    ]);
    expect(Object.keys(a.detalle.otros_ingresos_avion[0]).slice(-2)).toEqual([
      'tc_origen',
      'tc_aviso',
    ]);
    expect(a.ingresos.otros_ingresos_avion_tc_oficial_count).toBe(1);
    expect(a.ingresos.otros_ingresos_avion_sin_tc_mxn).toBe(0);
    expect(r.tc_oficial.ingresos).toEqual({ count: 1, monto_mxn: 46550.8 });
    expect(r.tc_oficial.fuentes).toContain('open.er-api');
  });

  it('(b) MXN con T.C. propio 17 ⇒ ÷ 17 sin pedir el oficial de su día', async () => {
    const { svc, diasOficiales } = armar(
      mundoReparto([{ ...ING_AVION, tc_usd_mxn: 17 }]),
      18,
    );
    const a = avionDe(await svc.compute({ desde: DESDE, hasta: HASTA }));
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(r2(46550.8 / 17));
    expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
      tc: 17,
      tc_oficial: false,
      tc_origen: 'PROPIO',
    });
    expect(a.ingresos.otros_ingresos_avion_tc_oficial_count).toBe(0);
    expect(diasOficiales).not.toContain('2026-09-04');
  });

  it('(c) USD 1,000 con comisión 30 ⇒ +970 (el neto en dólares; sin T.C.)', async () => {
    const sin = avionDe(await compute(mundoReparto()));
    const a = avionDe(
      await compute(
        mundoReparto([
          {
            ...ING_AVION,
            categoria: 'VENTA_ACTIVO',
            moneda: 'USD',
            monto: 1000,
            comision_monto: 30,
            tc_usd_mxn: 18.5,
          },
        ]),
      ),
    );
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(970);
    expect(a.saldo_disponible_usd).toBe(r2(sin.saldo_disponible_usd + 970));
    expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
      moneda: 'USD',
      monto: 1000,
      comision: 30,
      neto: 970,
      usd: 970,
      tc: null,
      tc_oficial: false,
      tc_origen: null,
    });
  });

  it('(d) MXN sin T.C. propio ni oficial ⇒ NO suma: va a `otros_ingresos_avion_sin_tc_mxn` y el saldo queda intacto', async () => {
    const sin = avionDe(await compute(mundoReparto()));
    const a = avionDe(await compute(mundoReparto([ING_AVION])));
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(0);
    expect(a.ingresos.otros_ingresos_avion_sin_tc_mxn).toBe(46550.8);
    expect(a.saldo_disponible_usd).toBe(sin.saldo_disponible_usd);
    expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
      usd: null,
      tc: null,
      tc_oficial: false,
      tc_origen: null,
    });
  });

  it('(e) sin efecto en ESTE avión: un ingreso de OTRO avión, uno de VuelaTour y un ANTICIPO con avión forzado', async () => {
    const sin = avionDe(await compute(mundoReparto(), 18));
    const r = await compute(
      mundoReparto([
        ...INGRESOS_LIBROS,
        { ...ING_AVION, id: 'i-dos', folio: 30, aeronave_id: AV2 },
        {
          ...ING_AVION,
          id: 'i-ant',
          folio: 31,
          categoria: 'ANTICIPO_CLIENTE',
          cliente: { nombre: 'Leticia León Alvarado' },
        },
      ]),
      18,
    );
    const a = avionDe(r);
    expect(a.saldo_disponible_usd).toBe(sin.saldo_disponible_usd);
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(0);
    expect(a.detalle.otros_ingresos_avion).toEqual([]);
    // El del XB-DOS sí suma en el XB-DOS.
    const dos = avionDe(r, AV2);
    expect(dos.ingresos.otros_ingresos_avion_usd).toBe(2586.16);
    expect(dos.detalle.otros_ingresos_avion.map((l) => l.clave)).toEqual([
      'ING-30',
    ]);
  });

  it('(f) `q.aeronave_id` limita: el reparto del XB-DOS no ve el ingreso del XB-TST', async () => {
    const r = await compute(mundoReparto([ING_AVION]), 18, {
      aeronave_id: AV2,
    });
    expect(r.aviones.map((a) => a.aeronave.id)).toEqual([AV2]);
    expect(r.aviones[0].ingresos.otros_ingresos_avion_usd).toBe(0);
    expect(r.tc_oficial.ingresos).toEqual({ count: 0, monto_mxn: 0 });
  });

  it('(g) sin ingresos con avión: llaves en 0 / [] y el cómputo es el MISMO con la tabla vacía, con ingresos de VuelaTour y sin la migración', async () => {
    const base = await compute(mundoReparto());
    const a = avionDe(base);
    expect([
      a.ingresos.otros_ingresos_avion_usd,
      a.ingresos.otros_ingresos_avion_sin_tc_mxn,
      a.ingresos.otros_ingresos_avion_tc_oficial_count,
      a.detalle.otros_ingresos_avion,
    ]).toEqual([0, 0, 0, []]);
    expect(base.tc_oficial.ingresos).toEqual({ count: 0, monto_mxn: 0 });
    const conVt = await compute(mundoReparto(INGRESOS_LIBROS));
    expect(diferencias(base, conVt)).toEqual([]);
    const sinMig = armar(mundoReparto([ING_AVION]), null, {
      sinMigracion: true,
    });
    const rSin = await sinMig.svc.compute({ desde: DESDE, hasta: HASTA });
    expect(diferencias(base, rSin)).toEqual([]);
    expect(sinMig.tablas).not.toContain('ingreso');
  });

  it('(h) tres ingresos del MISMO día ⇒ el T.C. oficial de ese día se pide UNA vez', async () => {
    const { svc, diasOficiales } = armar(
      mundoReparto([
        ING_AVION,
        { ...ING_AVION, id: 'i-b', folio: 15, monto: 1000 },
        { ...ING_AVION, id: 'i-c', folio: 16, monto: 2000, comision_monto: 20 },
      ]),
      18,
    );
    const r = await svc.compute({ desde: DESDE, hasta: HASTA });
    expect(diasOficiales.filter((d) => d === '2026-09-04')).toHaveLength(1);
    const a = avionDe(r);
    expect(a.ingresos.otros_ingresos_avion_tc_oficial_count).toBe(3);
    // Cada usd a centavos; el total = round2(Σ).
    const usds = a.detalle.otros_ingresos_avion.map((l) => l.usd!);
    expect(usds).toEqual([2586.16, r2(1000 / 18), r2(1980 / 18)]);
    expect(a.ingresos.otros_ingresos_avion_usd).toBe(
      r2(usds.reduce((s, x) => s + x, 0)),
    );
    expect(r.tc_oficial.ingresos).toEqual({
      count: 3,
      monto_mxn: r2(46550.8 + 1000 + 1980),
    });
  });

  it('(i) `buildRepartoPayload` manda las 3 llaves por avión (saldo YA con el ingreso)', async () => {
    const { svc } = armar(mundoReparto([ING_AVION]), 18);
    const { payload } = await (
      svc as unknown as {
        buildRepartoPayload: (q: { desde: string; hasta: string }) => Promise<{
          payload: {
            aviones: Array<Record<string, unknown>>;
            comision_vendedor_solo_gasto_real?: true;
          };
        }>;
      }
    ).buildRepartoPayload({ desde: DESDE, hasta: HASTA });
    const tst = payload.aviones.find((x) => x.matricula === 'XB-TST')!;
    expect(tst.otros_ingresos_avion_usd).toBe(2586.16);
    expect(tst.otros_ingresos_avion_sin_tc_mxn).toBe(0);
    expect(tst.otros_ingresos_avion).toEqual([
      {
        clave: 'ING-14',
        fecha: '2026-09-04',
        categoria: 'Reembolsos y devoluciones recibidos',
        concepto: 'TRANSF INTERBANCARIA SPEI · angel alvarez',
        monto: 46550.8,
        moneda: 'MXN',
        comision: null,
        usd: 2586.16,
        // ADITIVO (0.0.94, invariante 92): el neto EN PESOS.
        mxn: 46550.8,
      },
    ]);
    expect(Object.keys(tst).slice(-3)).toEqual([
      'otros_ingresos_avion_usd',
      'otros_ingresos_avion_sin_tc_mxn',
      'otros_ingresos_avion',
    ]);
    const dos = payload.aviones.find((x) => x.matricula === 'XB-DOS')!;
    expect([
      dos.otros_ingresos_avion_usd,
      dos.otros_ingresos_avion_sin_tc_mxn,
      dos.otros_ingresos_avion,
    ]).toEqual([0, 0, []]);
    // La bandera raíz del 0.0.74 sigue siendo la ÚLTIMA llave.
    expect(payload.comision_vendedor_solo_gasto_real).toBe(true);
  });

  it('(j) utilidades por mes (cuenta corriente): cada socio recibe su parte del saldo CON el ingreso', async () => {
    const { svc: sinSvc } = armar(mundoReparto(), 18);
    const { svc } = armar(mundoReparto([ING_AVION]), 18);
    const [sepSin] = await sinSvc.utilidadesSociosPorMes(
      ['2026-09'],
      '2026-10',
    );
    const [sep] = await svc.utilidadesSociosPorMes(['2026-09'], '2026-10');
    const socios = (m: typeof sep) =>
      m.aviones.find((x) => x.aeronave.id === AV)!.socios;
    const total = (m: typeof sep) =>
      r2(socios(m).reduce((s, x) => s + x.monto_usd, 0));
    expect(r2(total(sep) - total(sepSin))).toBe(2586.16);
    const mau = socios(sep).find((s) => s.socio_id === MAU)!.monto_usd;
    const mauSin = socios(sepSin).find((s) => s.socio_id === MAU)!.monto_usd;
    expect(Math.abs(r2(mau - mauSin) - 0.71 * 2586.16)).toBeLessThanOrEqual(
      0.01,
    );
  });
  describe('(k) REEMBOLSO LIGADO a un gasto en pesos que ESTE avión resta (0.0.77, revisión F3)', () => {
    /** Gasto DIRECTO del XB-TST (GAS, MXN 3,000 del 10-sep) del mundo. */
    const GASTO_LIGADO = 'g-gas';
    const reembolso = (extra: Fila = {}): Fila => ({
      ...ING_AVION,
      id: 'i-lig',
      folio: 40,
      monto: 3000,
      gasto_id: GASTO_LIGADO,
      ...extra,
    });
    const conTcGasto = (m: Record<string, Fila[]>, tc: number) => ({
      ...m,
      gasto: m.gasto.map((g) =>
        g.id === GASTO_LIGADO ? { ...g, tc_gasto: tc } : g,
      ),
    });
    /** Oficial distinto el día del ingreso (09-04) y el del gasto (09-10). */
    const POR_DIA = { '2026-09-04': 16.9479, '2026-09-10': 17.1211 };

    it('con `tc_gasto` 17.5 del gasto: el reembolso se convierte con 17.5 (no con el oficial de SU día) y se anula EXACTO con el gasto', async () => {
      const base = mundoReparto();
      const { svc: sinSvc } = armar(conTcGasto(base, 17.5), POR_DIA);
      const sin = avionDe(await sinSvc.compute({ desde: DESDE, hasta: HASTA }));
      const { svc } = armar(
        conTcGasto(mundoReparto([reembolso()]), 17.5),
        POR_DIA,
      );
      const a = avionDe(await svc.compute({ desde: DESDE, hasta: HASTA }));
      expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
        clave: 'ING-40',
        usd: r2(3000 / 17.5),
        tc: 17.5,
        tc_oficial: false,
        tc_origen: 'GASTO_LIGADO',
      });
      expect(a.ingresos.otros_ingresos_avion_usd).toBe(171.43);
      expect(a.ingresos.otros_ingresos_avion_tc_oficial_count).toBe(0);
      // Lo que el gasto RESTÓ (toUsd con su tc_gasto) == lo que el reembolso
      // SUMA: frente a un mundo sin el gasto, el reembolso lo anula al centavo.
      const sinGasto = (m: Record<string, Fila[]>) => ({
        ...m,
        gasto: m.gasto.filter((g) => g.id !== GASTO_LIGADO),
      });
      const { svc: nadaSvc } = armar(sinGasto(base), POR_DIA);
      const nada = avionDe(
        await nadaSvc.compute({ desde: DESDE, hasta: HASTA }),
      );
      expect(r2(nada.saldo_disponible_usd - sin.saldo_disponible_usd)).toBe(
        171.43,
      );
      expect(a.saldo_disponible_usd).toBe(nada.saldo_disponible_usd);
    });

    it('sin `tc_gasto`: el divisor es el oficial del día del GASTO (17.1211 del 10-sep), no el del ingreso (16.9479 del 4-sep)', async () => {
      const { svc } = armar(mundoReparto([reembolso()]), POR_DIA);
      const a = avionDe(await svc.compute({ desde: DESDE, hasta: HASTA }));
      expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
        usd: r2(3000 / 17.1211),
        tc: 17.1211,
        tc_oficial: false,
        tc_origen: 'GASTO_LIGADO',
      });
      expect(a.ingresos.otros_ingresos_avion_usd).toBe(175.22);
      expect(a.ingresos.otros_ingresos_avion_usd).not.toBe(r2(3000 / 16.9479));
      // Reembolsa EXACTO lo que el avión cargó: sin aviso.
      expect(a.detalle.otros_ingresos_avion[0].tc_aviso).toBeNull();
    });

    it('revisión del 14-oct-2026: un reembolso MAYOR que lo que el avión cargó del gasto se convierte con el divisor del gasto y lo AVISA en `tc_aviso`', async () => {
      const { svc } = armar(
        mundoReparto([reembolso({ monto: 3500 })]),
        POR_DIA,
      );
      const a = avionDe(await svc.compute({ desde: DESDE, hasta: HASTA }));
      expect(a.detalle.otros_ingresos_avion[0]).toMatchObject({
        usd: r2(3500 / 17.1211),
        tc: 17.1211,
        tc_origen: 'GASTO_LIGADO',
        tc_aviso:
          'ING-40 reembolsa $3,500 MXN de un gasto del que este libro solo le carga $3,000 MXN al avión: $500 MXN no se anulan con nada y suman al avión — si esa parte no es suya, corrige el monto o el avión del ingreso',
      });
    });

    it('ligado a un gasto que este avión NO resta (otro id, o una categoría que no es REEMBOLSO_DEVOLUCION): la regla por ingreso (oficial de SU día)', async () => {
      const { svc } = armar(
        mundoReparto([
          reembolso({ gasto_id: 'g-de-otro-mes' }),
          reembolso({
            id: 'i-otro',
            folio: 41,
            categoria: 'OTRO_INGRESO',
          }),
        ]),
        POR_DIA,
      );
      const a = avionDe(await svc.compute({ desde: DESDE, hasta: HASTA }));
      expect(
        a.detalle.otros_ingresos_avion.map((l) => [
          l.clave,
          l.usd,
          l.tc,
          l.tc_origen,
        ]),
      ).toEqual([
        ['ING-40', r2(3000 / 16.9479), 16.9479, 'OFICIAL_DEL_DIA'],
        ['ING-41', r2(3000 / 16.9479), 16.9479, 'OFICIAL_DEL_DIA'],
      ]);
      expect(a.ingresos.otros_ingresos_avion_tc_oficial_count).toBe(2);
    });
  });
});
