import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ETIQUETA_FACTURA_NO_LLEVA,
  ETIQUETA_FACTURA_PENDIENTE,
} from './factura-cliente.util';
import {
  etiquetasFacturaDeVuelos,
  facturasDeVuelos,
} from './factura-cliente-etiquetas';

/**
 * Lote de etiquetas de factura para los Excel (24-sep-2026): la columna
 * «FACTURA VUELATOUR» del Libro Dinero y «factura vuelatour» del balance ya
 * no dependen SOLO de la tabla `factura` (CFDI del PAC, 0 filas en prod).
 * Se congela: la cascada en lote, sin N+1, y la tolerancia a las dos
 * migraciones pendientes (sin 500, sin pedir columnas que no existen).
 *
 * Desde el 13-oct-2026 (invariante 60) el lote lee también `cobro_vuelo`
 * (PAGINADA de 1000 en 1000, como el PostgREST real) para el paso 5 de la
 * cascada: «Pendiente de factura» / «No lleva factura» / vacío = sin cobros.
 */

type Fila = Record<string, unknown>;

interface Mundo {
  factura?: Fila[];
  vuelo?: Fila[];
  cobro_vuelo?: Fila[];
  /** false = 42703 al pedir `factura_estatus` (sin 20260923000001). */
  estatus?: boolean;
  /** false = 42703 al pedir `factura_folio` (sin 20260924000001). */
  folio?: boolean;
  /** error de lectura de la tabla `factura`. */
  errorFactura?: string;
  /** error de lectura de la tabla `cobro_vuelo`. */
  errorCobros?: string;
  /**
   * true = migración 20260924000003 aplicada (registro de facturas
   * emitidas). Default: NO aplicada (42703 al sondear
   * `vuelo.factura_solicitada_at`) — el Excel sale como antes.
   */
  emitida?: boolean;
  /** Filas del puente con su factura embebida (solo con `emitida`). */
  factura_emitida_vuelo?: Fila[];
}

/** max-rows de PostgREST: una respuesta nunca trae más de 1000 filas. */
const MAX_ROWS = 1000;

interface Consulta {
  tabla: string;
  select: string;
  ids?: unknown[];
  range?: [number, number];
}

function fake(m: Mundo) {
  const consultas: Consulta[] = [];
  const from = (tabla: string) => {
    let select = '';
    let ids: unknown[] | undefined;
    let rango: [number, number] | undefined;
    let orden: { col: string; asc: boolean } | undefined;
    let filas = [...(((m as Record<string, unknown>)[tabla] as Fila[]) ?? [])];
    const q: Record<string, unknown> = {};
    q.select = (s: string) => {
      select = s;
      return q;
    };
    q.in = (col: string, arr: unknown[]) => {
      ids = arr;
      filas = filas.filter((f) => arr.includes(f[col]));
      return q;
    };
    q.neq = (col: string, v: unknown) => {
      filas = filas.filter((f) => f[col] !== v);
      return q;
    };
    q.order = (col: string, o?: { ascending?: boolean }) => {
      orden = { col, asc: o?.ascending !== false };
      return q;
    };
    q.range = (a: number, b: number) => {
      rango = [a, b];
      return q;
    };
    q.limit = () => q;
    q.then = (res: (v: unknown) => unknown) => {
      consultas.push({ tabla, select, ids, range: rango });
      const faltante =
        tabla === 'vuelo' &&
        ((m.estatus === false && select.includes('factura_estatus')) ||
          (m.folio === false && select.includes('factura_folio')) ||
          (m.emitida !== true && select.includes('factura_solicitada_at')));
      if (faltante) {
        return Promise.resolve({
          data: null,
          error: { code: '42703', message: 'column does not exist' },
        }).then(res);
      }
      if (tabla === 'factura' && m.errorFactura) {
        return Promise.resolve({
          data: null,
          error: { message: m.errorFactura },
        }).then(res);
      }
      if (tabla === 'cobro_vuelo' && m.errorCobros) {
        return Promise.resolve({
          data: null,
          error: { message: m.errorCobros },
        }).then(res);
      }
      // El puente trae la factura EMBEBIDA: se devuelve la fila tal cual.
      if (tabla === 'factura_emitida_vuelo') {
        return Promise.resolve({ data: filas, error: null }).then(res);
      }
      if (orden) {
        const { col, asc } = orden;
        const txt = (v: unknown) =>
          typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
        filas = [...filas].sort((a, b) => {
          const x = txt(a[col]);
          const y = txt(b[col]);
          return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      // PostgREST real: `range(a, b)` devuelve ese tramo y NUNCA más de
      // max-rows filas por respuesta.
      const [a, b] = rango ?? [0, Number.MAX_SAFE_INTEGER];
      filas = filas.slice(a, Math.min(b + 1, a + MAX_ROWS));
      // Proyección REAL de columnas: una columna no pedida no llega (así se
      // prueba que sin la migración el folio no se «cuela» en la etiqueta).
      const cols = select.split(',').map((c) => c.trim());
      const data = filas.map((f) =>
        Object.fromEntries(cols.filter((c) => c in f).map((c) => [c, f[c]])),
      );
      return Promise.resolve({ data, error: null }).then(res);
    };
    return q;
  };
  return { sb: { from } as unknown as SupabaseClient, consultas };
}

const V1 = 'v-1';
const V2 = 'v-2';
const V3 = 'v-3';
const V4 = 'v-4';

const cobro = (id: string, vuelo_id: string, extra: Fila = {}): Fila => ({
  id,
  vuelo_id,
  monto: 1000,
  cuenta_destino: null,
  metodo_cobro: 'EFECTIVO',
  ...extra,
});

describe('etiquetasFacturaDeVuelos', () => {
  const mundo: Mundo = {
    factura: [
      { vuelo_id: V1, serie: 'VT', folio: '501', estado: 'TIMBRADA' },
      { vuelo_id: V2, serie: 'VT', folio: '9', estado: 'CANCELADA' },
    ],
    vuelo: [
      // CFDI vivo manda aunque haya folio manual.
      {
        id: V1,
        facturado: true,
        factura_estatus: 'FACTURADO',
        factura_folio: 'X',
      },
      // CFDI cancelado ⇒ vale el folio de la factura subida.
      {
        id: V2,
        facturado: false,
        factura_estatus: 'FACTURADO',
        factura_folio: 'A-1234',
      },
      // Caso #297: FACTURADO sin archivo ni folio.
      {
        id: V3,
        facturado: false,
        factura_estatus: 'FACTURADO',
        factura_folio: null,
      },
      // Sin nada.
      {
        id: V4,
        facturado: false,
        factura_estatus: 'SIN_FACTURA',
        factura_folio: null,
      },
    ],
  };

  it('cascada: CFDI vivo → folio → estatus → nada', async () => {
    const { sb } = fake(mundo);
    const m = await etiquetasFacturaDeVuelos(sb, [V1, V2, V3, V4]);
    expect(Object.fromEntries(m)).toEqual({
      [V1]: 'VT-501',
      [V2]: 'A-1234',
      [V3]: 'Facturado',
    });
  });

  it('EN LOTE: una consulta a `factura`, una a `vuelo` y una a `cobro_vuelo` (más las sondas), nunca N+1', async () => {
    const { sb, consultas } = fake(mundo);
    await etiquetasFacturaDeVuelos(sb, [V1, V2, V3, V4, V1]);
    const deNegocio = consultas.filter((c) => c.ids);
    expect(deNegocio.map((c) => c.tabla).sort()).toEqual([
      'cobro_vuelo',
      'factura',
      'vuelo',
    ]);
    // Ids sin repetir, en las tres.
    for (const c of deNegocio) expect(c.ids).toHaveLength(4);
  });

  it('más de 200 vuelos ⇒ lotes de 200 (la URL de PostgREST no crece sin tope), también para los cobros', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `v-${i}`);
    const { sb, consultas } = fake({ factura: [], vuelo: [] });
    await etiquetasFacturaDeVuelos(sb, ids);
    const lotes = consultas.filter((c) => c.tabla === 'vuelo' && c.ids);
    expect(lotes.map((c) => c.ids!.length)).toEqual([200, 200, 50]);
    const lotesCobros = consultas.filter((c) => c.tabla === 'cobro_vuelo');
    expect(lotesCobros.map((c) => c.ids!.length)).toEqual([200, 200, 50]);
  });

  it('sin la migración del FOLIO: no lo pide y cae al estatus (el Excel sale igual que hoy)', async () => {
    const { sb, consultas } = fake({ ...mundo, folio: false });
    const m = await etiquetasFacturaDeVuelos(sb, [V2, V3]);
    expect(Object.fromEntries(m)).toEqual({
      [V2]: 'Facturado',
      [V3]: 'Facturado',
    });
    const lectura = consultas.find((c) => c.tabla === 'vuelo' && c.ids)!;
    // `tc_usd_mxn` SIEMPRE (14-oct-2026, API 0.0.77): respaldo de
    // `cobrosEnUsd` para la regla 2 del anticipo devuelto.
    expect(lectura.select).toBe(
      'id, facturado, factura_estatus, estado, tc_usd_mxn',
    );
  });

  it('sin NINGUNA de las dos migraciones: solo `facturado` (CFDI) y `estado`', async () => {
    const { sb, consultas } = fake({ ...mundo, estatus: false });
    const m = await etiquetasFacturaDeVuelos(sb, [V1, V3]);
    expect(Object.fromEntries(m)).toEqual({ [V1]: 'VT-501' });
    const lectura = consultas.find((c) => c.tabla === 'vuelo' && c.ids)!;
    expect(lectura.select).toBe('id, facturado, estado, tc_usd_mxn');
  });

  describe('con el registro de facturas EMITIDAS (migración 20260924000003)', () => {
    const fe = (
      vuelo_id: string,
      serie: string | null,
      folio: string,
      folio_num: number | null,
      estatus = 'VIGENTE',
      deleted_at: string | null = null,
    ): Fila => ({
      vuelo_id,
      factura: { serie, folio, folio_num, estatus, deleted_at },
    });

    it('cascada: CFDI vivo → EMITIDAS vigentes («A-123, A-130») → folio legado → estatus', async () => {
      const { sb, consultas } = fake({
        ...mundo,
        emitida: true,
        factura_emitida_vuelo: [
          // V1 tiene CFDI vivo: manda sobre la emitida.
          fe(V1, 'A', '99', 99),
          // V2: dos vigentes (desordenadas) + una cancelada + una borrada
          // ⇒ solo las vigentes, por número, y ganan al folio legado.
          fe(V2, 'A', '130', 130),
          fe(V2, 'A', '123', 123),
          fe(V2, 'A', '120', 120, 'CANCELADA'),
          fe(V2, 'A', '121', 121, 'VIGENTE', '2026-09-24T10:00:00Z'),
          // V3: solo cancelada ⇒ cae al estatus manual.
          fe(V3, 'B', '7', 7, 'CANCELADA'),
          // V4: sin serie.
          fe(V4, null, '555', 555),
        ],
      });
      const m = await etiquetasFacturaDeVuelos(sb, [V1, V2, V3, V4]);
      expect(Object.fromEntries(m)).toEqual({
        [V1]: 'VT-501',
        [V2]: 'A-123, A-130',
        [V3]: 'Facturado',
        [V4]: '555',
      });
      // Con la sonda, el select de `vuelo` pide la solicitud viva y su nota
      // (la AUTOMÁTICA se distingue por la nota, 0.0.77); `tc_usd_mxn`
      // siempre.
      const lectura = consultas.find((c) => c.tabla === 'vuelo' && c.ids)!;
      expect(lectura.select).toBe(
        'id, facturado, factura_estatus, factura_folio, estado, tc_usd_mxn, factura_solicitada_at, factura_solicitud_nota',
      );
    });

    it('el puente se lee EN LOTE (una consulta por cada 200 vuelos)', async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `v-${i}`);
      const { sb, consultas } = fake({
        factura: [],
        vuelo: [],
        emitida: true,
        factura_emitida_vuelo: [],
      });
      await etiquetasFacturaDeVuelos(sb, ids);
      const lotes = consultas.filter(
        (c) => c.tabla === 'factura_emitida_vuelo' && c.ids,
      );
      expect(lotes.map((c) => c.ids!.length)).toEqual([200, 50]);
    });

    it('sin la migración NO consulta el puente (Excel idéntico a hoy)', async () => {
      const { sb, consultas } = fake({ ...mundo, emitida: false });
      await etiquetasFacturaDeVuelos(sb, [V1, V2]);
      expect(consultas.some((c) => c.tabla === 'factura_emitida_vuelo')).toBe(
        false,
      );
    });
  });

  describe('paso 5 — lo que dicen los COBROS (13-oct-2026, invariante 60)', () => {
    const sinFactura = (id: string): Fila => ({
      id,
      estado: 'COMPLETADO',
      facturado: false,
      factura_estatus: 'SIN_FACTURA',
      factura_folio: null,
      factura_solicitada_at: null,
    });

    it('cobro en HSBC Pesos y SIN_FACTURA ⇒ «Pendiente de factura»; solo BillPocket/efectivo ⇒ «No lleva factura»; sin cobros ⇒ ausente', async () => {
      const { sb } = fake({
        factura: [],
        vuelo: [sinFactura(V1), sinFactura(V2), sinFactura(V3)],
        cobro_vuelo: [
          cobro('c-1', V1, { metodo_cobro: 'BILLPOCKET' }),
          cobro('c-2', V1, {
            cuenta_destino: 'HSBC Pesos',
            metodo_cobro: 'TRANSFERENCIA',
          }),
          cobro('c-3', V2, { metodo_cobro: 'BILLPOCKET' }),
          cobro('c-4', V2, { metodo_cobro: 'EFECTIVO' }),
        ],
      });
      const m = await etiquetasFacturaDeVuelos(sb, [V1, V2, V3]);
      expect(Object.fromEntries(m)).toEqual({
        [V1]: ETIQUETA_FACTURA_PENDIENTE,
        [V2]: ETIQUETA_FACTURA_NO_LLEVA,
      });
      const d = await facturasDeVuelos(sb, [V1, V2, V3]);
      expect(d.get(V1)).toEqual({
        registrada: null,
        exigencia: 'EXIGE',
        solicitada: false,
        estado: 'COMPLETADO',
        cuentas_exigen: ['HSBC Pesos'],
        etiqueta: ETIQUETA_FACTURA_PENDIENTE,
        // ADITIVOS (14-oct-2026, API 0.0.77), al final.
        origenes_exigen: ['en HSBC Pesos'],
        solicitud_automatica: false,
        solicitud_ya_no_aplica: false,
      });
      expect(d.get(V2)).toMatchObject({
        registrada: null,
        exigencia: 'NO_EXIGE',
        cuentas_exigen: [],
        etiqueta: ETIQUETA_FACTURA_NO_LLEVA,
      });
      // Sin cobros: en el detalle, con exigencia SIN_COBROS y etiqueta null.
      expect(d.get(V3)).toEqual({
        registrada: null,
        exigencia: 'SIN_COBROS',
        solicitada: false,
        estado: 'COMPLETADO',
        cuentas_exigen: [],
        etiqueta: null,
        origenes_exigen: [],
        solicitud_automatica: false,
        solicitud_ya_no_aplica: false,
      });
    });

    it('un reembolso (monto negativo) no cuenta: solo reembolsos ⇒ sin cobros', async () => {
      const { sb } = fake({
        factura: [],
        vuelo: [sinFactura(V1)],
        cobro_vuelo: [
          cobro('c-1', V1, {
            monto: -500,
            cuenta_destino: 'HSBC Pesos',
            metodo_cobro: 'TRANSFERENCIA',
          }),
        ],
      });
      expect((await etiquetasFacturaDeVuelos(sb, [V1])).size).toBe(0);
      expect((await facturasDeVuelos(sb, [V1])).get(V1)?.exigencia).toBe(
        'SIN_COBROS',
      );
    });

    // Revisión 13-oct-2026: la lectura trae `moneda` y la exigencia es por
    // el NETO de cada cuenta y moneda. Decisión del cliente del 14-oct-2026
    // («¿Un anticipo devuelto lleva CFDI?» ⇒ «eso no»): devuelto COMPLETO
    // POR CUALQUIER VÍA (misma cuenta o EFECTIVO) ⇒ «No lleva factura».
    it('CANCELADO con HSBC Dólares +1000 devuelto COMPLETO en la misma cuenta o en EFECTIVO −1000 ⇒ «No lleva factura» (NO_EXIGE); devuelto en parte ⇒ «Pendiente de factura»', async () => {
      const hsbc = (id: string, vuelo: string, monto: number) =>
        cobro(id, vuelo, {
          monto,
          moneda: 'USD',
          cuenta_destino: 'HSBC Dólares',
          metodo_cobro: 'TRANSFERENCIA',
        });
      const { sb, consultas } = fake({
        factura: [],
        vuelo: [
          { ...sinFactura(V1), estado: 'CANCELADO' },
          { ...sinFactura(V2), estado: 'CANCELADO' },
          { ...sinFactura(V3), estado: 'CANCELADO' },
        ],
        cobro_vuelo: [
          hsbc('c-1', V1, 1000),
          hsbc('c-2', V1, -1000),
          hsbc('c-3', V2, 1000),
          hsbc('c-4', V2, -400),
          hsbc('c-5', V3, 1000),
          cobro('c-6', V3, { monto: -1000, moneda: 'USD' }),
        ],
      });
      const d = await facturasDeVuelos(sb, [V1, V2, V3]);
      expect(d.get(V1)).toMatchObject({
        exigencia: 'NO_EXIGE',
        cuentas_exigen: [],
        etiqueta: ETIQUETA_FACTURA_NO_LLEVA,
      });
      expect(d.get(V2)).toMatchObject({
        exigencia: 'EXIGE',
        cuentas_exigen: ['HSBC Dólares'],
        origenes_exigen: ['en HSBC Dólares'],
        etiqueta: ETIQUETA_FACTURA_PENDIENTE,
      });
      expect(d.get(V3)).toMatchObject({
        exigencia: 'NO_EXIGE',
        cuentas_exigen: [],
        origenes_exigen: [],
        etiqueta: ETIQUETA_FACTURA_NO_LLEVA,
      });
      expect(consultas.find((c) => c.tabla === 'cobro_vuelo')?.select).toBe(
        'id, vuelo_id, monto, moneda, tc_usd_mxn, cuenta_destino, metodo_cobro',
      );
    });

    it('USD devuelto en MXN con T.C. (regla 2, con `cobrado` del lector) ⇒ NO_EXIGE; con el T.C. del VUELO de respaldo también', async () => {
      const { sb } = fake({
        factura: [],
        vuelo: [
          { ...sinFactura(V1), estado: 'CANCELADO', tc_usd_mxn: 17.5 },
          { ...sinFactura(V2), estado: 'CANCELADO', tc_usd_mxn: 17.5 },
        ],
        cobro_vuelo: [
          cobro('c-1', V1, {
            monto: 1000,
            moneda: 'USD',
            cuenta_destino: 'HSBC Dólares',
            metodo_cobro: 'TRANSFERENCIA',
          }),
          cobro('c-2', V1, {
            monto: -17500,
            moneda: 'MXN',
            tc_usd_mxn: 17.5,
            cuenta_destino: 'HSBC Pesos',
            metodo_cobro: 'TRANSFERENCIA',
          }),
          // Reembolso en pesos SIN T.C. propio: el del vuelo (17.5) lo
          // convierte (`cobrosEnUsd`, invariante 2).
          cobro('c-3', V2, {
            monto: 1000,
            moneda: 'USD',
            cuenta_destino: 'HSBC Dólares',
            metodo_cobro: 'TRANSFERENCIA',
          }),
          cobro('c-4', V2, { monto: -17500, moneda: 'MXN' }),
        ],
      });
      const d = await facturasDeVuelos(sb, [V1, V2]);
      expect(d.get(V1)).toMatchObject({
        exigencia: 'NO_EXIGE',
        etiqueta: ETIQUETA_FACTURA_NO_LLEVA,
      });
      expect(d.get(V2)).toMatchObject({
        exigencia: 'NO_EXIGE',
        etiqueta: ETIQUETA_FACTURA_NO_LLEVA,
      });
    });

    it('la factura REGISTRADA gana a los cobros', async () => {
      const { sb } = fake({
        factura: [
          { vuelo_id: V1, serie: 'VT', folio: '7', estado: 'TIMBRADA' },
        ],
        vuelo: [
          { ...sinFactura(V1), facturado: true },
          { ...sinFactura(V2), factura_estatus: 'ELABORADA_ENVIADA' },
        ],
        cobro_vuelo: [
          cobro('c-1', V1, { cuenta_destino: 'HSBC Pesos' }),
          cobro('c-2', V2, { cuenta_destino: 'Scotiabank Dólares' }),
        ],
      });
      const d = await facturasDeVuelos(sb, [V1, V2]);
      expect(d.get(V1)).toMatchObject({
        registrada: 'VT-7',
        exigencia: 'EXIGE',
        etiqueta: 'VT-7',
      });
      expect(d.get(V2)).toMatchObject({
        registrada: 'Factura elaborada y enviada',
        exigencia: 'EXIGE',
        cuentas_exigen: ['Scotiabank Dólares'],
        etiqueta: 'Factura elaborada y enviada',
      });
    });

    it('solicitud viva ⇒ «Pendiente de factura» SOLO con la sonda (sin ella `solicitada: false`)', async () => {
      const vuelo = {
        ...sinFactura(V1),
        factura_solicitada_at: '2026-10-01T10:00:00Z',
      };
      const cobros = [cobro('c-1', V1, { metodo_cobro: 'BILLPOCKET' })];
      const con = fake({
        factura: [],
        vuelo: [vuelo],
        cobro_vuelo: cobros,
        emitida: true,
        factura_emitida_vuelo: [],
      });
      expect((await facturasDeVuelos(con.sb, [V1])).get(V1)).toMatchObject({
        exigencia: 'NO_EXIGE',
        solicitada: true,
        etiqueta: ETIQUETA_FACTURA_PENDIENTE,
      });
      const sin = fake({ factura: [], vuelo: [vuelo], cobro_vuelo: cobros });
      expect((await facturasDeVuelos(sin.sb, [V1])).get(V1)).toMatchObject({
        exigencia: 'NO_EXIGE',
        solicitada: false,
        etiqueta: ETIQUETA_FACTURA_NO_LLEVA,
      });
    });

    it('facturasDeVuelos devuelve TODOS los ids pedidos (también uno que no existe en `vuelo`)', async () => {
      const { sb } = fake({
        factura: [],
        vuelo: [sinFactura(V1)],
        cobro_vuelo: [
          cobro('c-9', 'v-fantasma', { cuenta_destino: 'HSBC Dólares' }),
        ],
      });
      const d = await facturasDeVuelos(sb, [V1, 'v-fantasma']);
      expect([...d.keys()]).toEqual([V1, 'v-fantasma']);
      expect(d.get('v-fantasma')).toEqual({
        registrada: null,
        exigencia: 'EXIGE',
        solicitada: false,
        estado: null,
        cuentas_exigen: ['HSBC Dólares'],
        etiqueta: ETIQUETA_FACTURA_PENDIENTE,
        origenes_exigen: ['en HSBC Dólares'],
        solicitud_automatica: false,
        solicitud_ya_no_aplica: false,
      });
    });

    it('PAGINACIÓN: 1 001 cobros en un lote ⇒ 2 páginas y ningún cobro perdido (el vuelo 1 001 no sale «sin cobros»)', async () => {
      // V1 con 1 000 cobros en efectivo (ids c-0000…c-0999) y V2 con UN
      // cobro en HSBC cuyo id ordena DESPUÉS: sin paginar, PostgREST
      // entregaría solo los 1 000 primeros y V2 saldría sin cobros.
      const cobros: Fila[] = Array.from({ length: 1000 }, (_, i) =>
        cobro(`c-${String(i).padStart(4, '0')}`, V1),
      );
      cobros.push(
        cobro('z-hsbc', V2, {
          cuenta_destino: 'HSBC Pesos',
          metodo_cobro: 'TRANSFERENCIA',
        }),
      );
      const { sb, consultas } = fake({
        factura: [],
        vuelo: [sinFactura(V1), sinFactura(V2)],
        cobro_vuelo: cobros,
      });
      const m = await etiquetasFacturaDeVuelos(sb, [V1, V2]);
      expect(Object.fromEntries(m)).toEqual({
        [V1]: ETIQUETA_FACTURA_NO_LLEVA,
        [V2]: ETIQUETA_FACTURA_PENDIENTE,
      });
      const paginas = consultas.filter((c) => c.tabla === 'cobro_vuelo');
      expect(paginas.map((c) => c.range)).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
    });

    it('un error al leer `cobro_vuelo` se LANZA (nunca una columna vacía en silencio)', async () => {
      const { sb } = fake({
        factura: [],
        vuelo: [sinFactura(V1)],
        errorCobros: 'statement timeout',
      });
      await expect(etiquetasFacturaDeVuelos(sb, [V1])).rejects.toThrow(
        'statement timeout',
      );
      await expect(facturasDeVuelos(sb, [V1])).rejects.toThrow(
        'statement timeout',
      );
    });
  });

  describe('solicitud que CUENTA (14-oct-2026, API 0.0.77, revisión F2)', () => {
    const base = (id: string, extra: Fila = {}): Fila => ({
      id,
      estado: 'COMPLETADO',
      facturado: false,
      factura_estatus: 'SIN_FACTURA',
      factura_folio: null,
      factura_solicitada_at: '2026-10-01T10:00:00Z',
      factura_solicitud_nota: null,
      ...extra,
    });
    const NOTA_AUTO = 'Solicitada automáticamente: cobro en HSBC Pesos';
    const hp = (id: string, vuelo: string, monto: number, extra: Fila = {}) =>
      cobro(id, vuelo, {
        monto,
        moneda: 'MXN',
        tc_usd_mxn: 17.3,
        cuenta_destino: 'HSBC Pesos',
        metodo_cobro: 'TRANSFERENCIA',
        ...extra,
      });
    const efectivo = (id: string, vuelo: string, monto: number) =>
      cobro(id, vuelo, { monto, moneda: 'MXN', tc_usd_mxn: 17.3 });

    it('automática viva + NO_EXIGE ⇒ `solicitada` false y «No lleva factura»; manual viva + NO_EXIGE ⇒ «Pendiente de factura»', async () => {
      const { sb } = fake({
        factura: [],
        emitida: true,
        factura_emitida_vuelo: [],
        vuelo: [
          base(V1, { factura_solicitud_nota: NOTA_AUTO }),
          base(V2, { factura_solicitud_nota: 'La pidió el cliente' }),
        ],
        cobro_vuelo: [
          hp('c-1', V1, 30000),
          efectivo('c-2', V1, -30000),
          hp('c-3', V2, 30000),
          efectivo('c-4', V2, -30000),
        ],
      });
      const d = await facturasDeVuelos(sb, [V1, V2]);
      expect(d.get(V1)).toMatchObject({
        exigencia: 'NO_EXIGE',
        solicitada: false,
        solicitud_automatica: true,
        solicitud_ya_no_aplica: true,
        etiqueta: ETIQUETA_FACTURA_NO_LLEVA,
      });
      expect(d.get(V2)).toMatchObject({
        exigencia: 'NO_EXIGE',
        solicitada: true,
        solicitud_automatica: false,
        solicitud_ya_no_aplica: false,
        etiqueta: ETIQUETA_FACTURA_PENDIENTE,
      });
    });

    it('parcial ⇒ «Pendiente de factura» (la automática sigue contando)', async () => {
      const { sb } = fake({
        factura: [],
        emitida: true,
        factura_emitida_vuelo: [],
        vuelo: [base(V1, { factura_solicitud_nota: NOTA_AUTO })],
        cobro_vuelo: [hp('c-1', V1, 30000), efectivo('c-2', V1, -28500)],
      });
      expect((await facturasDeVuelos(sb, [V1])).get(V1)).toMatchObject({
        exigencia: 'EXIGE',
        solicitada: true,
        solicitud_ya_no_aplica: false,
        cuentas_exigen: ['HSBC Pesos'],
        origenes_exigen: ['en HSBC Pesos'],
        etiqueta: ETIQUETA_FACTURA_PENDIENTE,
      });
    });

    it('CANCELADO + manual viva: con BillPocket retenido o con el dinero devuelto completo ⇒ «Pendiente de factura» (no hereda la exclusión de CANCELADO)', async () => {
      const { sb } = fake({
        factura: [],
        emitida: true,
        factura_emitida_vuelo: [],
        vuelo: [
          base(V1, {
            estado: 'CANCELADO',
            factura_solicitud_nota: 'Cargo por cancelación',
          }),
          base(V2, {
            estado: 'CANCELADO',
            factura_solicitud_nota: 'Cargo por cancelación',
          }),
        ],
        cobro_vuelo: [
          cobro('c-1', V1, {
            monto: 30000,
            moneda: 'MXN',
            tc_usd_mxn: 17.3,
            metodo_cobro: 'BILLPOCKET',
          }),
          hp('c-2', V2, 30000),
          efectivo('c-3', V2, -30000),
        ],
      });
      const d = await facturasDeVuelos(sb, [V1, V2]);
      for (const id of [V1, V2]) {
        expect([id, d.get(id)]).toEqual([
          id,
          expect.objectContaining({
            exigencia: 'NO_EXIGE',
            solicitada: true,
            estado: 'CANCELADO',
            etiqueta: ETIQUETA_FACTURA_PENDIENTE,
          }),
        ]);
      }
    });

    it('`{ conCobros: true }` trae `cobros` y `tc_vuelo` (solo para el aviso); sin la opción, el contrato idéntico', async () => {
      const mundoCobros: Mundo = {
        factura: [],
        vuelo: [base(V1, { tc_usd_mxn: 17.3 })],
        cobro_vuelo: [hp('c-1', V1, 30000)],
      };
      const con = (
        await facturasDeVuelos(fake(mundoCobros).sb, [V1], { conCobros: true })
      ).get(V1)!;
      expect(con.tc_vuelo).toBe(17.3);
      expect(con.cobros).toEqual([
        {
          id: 'c-1',
          vuelo_id: V1,
          monto: 30000,
          moneda: 'MXN',
          tc_usd_mxn: 17.3,
          cuenta_destino: 'HSBC Pesos',
          metodo_cobro: 'TRANSFERENCIA',
        },
      ]);
      const sin = (await facturasDeVuelos(fake(mundoCobros).sb, [V1])).get(V1)!;
      expect(Object.keys(sin)).toEqual([
        'registrada',
        'exigencia',
        'solicitada',
        'estado',
        'cuentas_exigen',
        'etiqueta',
        'origenes_exigen',
        'solicitud_automatica',
        'solicitud_ya_no_aplica',
      ]);
    });
  });

  it('sin vuelos no consulta nada', async () => {
    const { sb, consultas } = fake(mundo);
    await expect(etiquetasFacturaDeVuelos(sb, [])).resolves.toEqual(new Map());
    await expect(facturasDeVuelos(sb, [])).resolves.toEqual(new Map());
    expect(consultas).toHaveLength(0);
  });

  it('un error REAL de lectura se lanza (nunca un libro con datos parciales)', async () => {
    const { sb } = fake({ ...mundo, errorFactura: 'timeout' });
    await expect(etiquetasFacturaDeVuelos(sb, [V1])).rejects.toThrow('timeout');
  });
});
