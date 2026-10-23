// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// El lector del consecutivo por cliente se reemplaza: aquí se prueban SOLO
// las columnas de identificación de las filas del Libro Dinero.
jest.mock('../../common/clave-cliente-lectura.util', () => ({
  clavesClienteDeVuelos: jest.fn().mockResolvedValue(new Map()),
  consecutivosClienteDeVuelos: jest.fn(),
  vueloIdsPorClaveCliente: jest.fn().mockResolvedValue([]),
}));

import { DineroReportService } from './dinero-report.service';
import { consecutivosClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
import { CLIENTE_VUELO_SERVICIO } from '../../common/clave-cliente.util';
import type { SupabaseService } from '../supabase/supabase.service';
import type { DineroXlsxPayload } from '../pyservices/pyservices.service';
import {
  AV,
  DESDE,
  GOLDEN_DINERO,
  HASTA,
  INGRESOS_LIBROS,
  V1,
  fakeSupabase,
  mundoLibros,
  vuelo2,
  type Fila,
} from '../aircraft/libros-pago-vendedor.fixture-spec';

// CIERRE DE MES (16-oct-2026, invariante 89): este spec congela la conducta
// SIN la migración 20261016000004 (0.0.87 byte a byte); la conducta con la
// migración vive en los specs `*.cierre-mes.spec.ts`.
jest.mock('../../common/cierre-mes-disponible.util', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../common/cierre-mes-disponible.util',
  ),
  cierreMesDisponible: jest.fn(() => Promise.resolve(false)),
}));

/**
 * LIBRO DINERO — CLAVES SIN APODO (23-oct-2026, API 0.0.105, invariante
 * 106). SOLO ETIQUETAS (fuente única `claveDinero`): la CLAVE de la hoja de
 * vuelos y de las filas «Otros ingresos» del vuelo es el folio «#501» (+
 * « (50 % XB-DOS)» en multi-avión); ya no el ID («beh05-011026»), ni el
 * legado «vtleticia», ni «vtservicio». Cada fila de vuelo lleva `cliente`
 * (nombre completo; «Vuelo de servicio» con `servicio: true` en un tramo de
 * taller), `ruta` y `consecutivo_cliente` (null si el lector no lo da).
 * Ningún importe ni utilidad cambia.
 */

const lector = consecutivosClienteDeVuelos as jest.MockedFunction<
  typeof consecutivosClienteDeVuelos
>;

const AV2 = 'av-2';
const V3 = 'v-3';
const V4 = 'v-4';

/** Forma de un ID por cliente («beh05-011026») y del legado («vtbeh»). */
const FORMA_ID = /[a-z]+[0-9]{2,}-[0-9]{6}/;
const FORMA_LEGADO = /^vt[a-záéíóúüñ]/i;

function lectorCon(consecutivos: Record<string, number>) {
  lector.mockImplementation((_sb, ids) =>
    Promise.resolve(
      new Map(
        [...new Set(ids)]
          .filter((id): id is string => !!id && consecutivos[id] != null)
          .map((id) => [id, consecutivos[id]] as [string, number]),
      ),
    ),
  );
}

/** Tramo con la forma que lee el Libro Dinero. */
function tramo(
  id: string,
  vueloId: string,
  orden: number,
  extra: Fila = {},
): Fila {
  return {
    id,
    vuelo_id: vueloId,
    orden,
    aeronave_id: null,
    cancelada_at: null,
    taco_salida: null,
    taco_llegada: null,
    solo_operativa: false,
    es_ferry: false,
    origen_iata: 'CUN',
    destino_iata: 'MID',
    es_sobrevuelo: false,
    tipo_parada: 'NORMAL',
    pasajeros: 2,
    ...extra,
  };
}

/**
 * El mundo de los libros (#501 con TUAS, extras y comisión ⇒ 3 filas de
 * «Otros ingresos») + #503 MULTI-AVIÓN (XB-TST y XB-DOS) + #504 de SERVICIO
 * (tramo de taller sin pasajeros). Con `extra` = sin #503/#504 (golden).
 */
function mundo(conExtras = true): Record<string, Fila[]> {
  const m = mundoLibros(INGRESOS_LIBROS);
  if (!conExtras) return m;
  return {
    ...m,
    aeronave: [
      ...m.aeronave,
      {
        id: AV2,
        matricula: 'XB-DOS',
        modelo: 'C206',
        color_calendario: '#10B981',
        permiso_afac_usd_hr: null,
        servicio_intervalos: [],
        servicio_horas_base: 0,
      },
    ],
    vuelo: [
      ...m.vuelo,
      vuelo2({
        id: V3,
        folio: 503,
        fecha_vuelo: '2026-09-15T15:00:00+00:00',
        tiempo_cobrable_hr: 2,
        subtotal_vuelo_usd: 2000,
        monto_total_usd: 2000,
        monto_total_mxn: 36000,
      }),
      vuelo2({
        id: V4,
        folio: 504,
        fecha_vuelo: '2026-09-18T15:00:00+00:00',
        subtotal_vuelo_usd: 0,
        monto_total_usd: 0,
        monto_total_mxn: 0,
      }),
    ],
    escala: [
      ...m.escala,
      tramo('e-3a', V3, 1),
      tramo('e-3b', V3, 2, {
        aeronave_id: AV2,
        origen_iata: 'MID',
        destino_iata: 'CUN',
      }),
      tramo('e-4', V4, 1, { tipo_parada: 'SERVICIO', pasajeros: 0 }),
    ],
  };
}

type Privado = {
  buildPayload: (desde: string, hasta: string) => Promise<DineroXlsxPayload>;
};

async function libro(conExtras = true): Promise<DineroXlsxPayload> {
  const f = fakeSupabase(mundo(conExtras));
  const service = new DineroReportService(
    f.supabase as unknown as SupabaseService,
    {} as never,
  );
  const p = await (service as unknown as Privado).buildPayload(DESDE, HASTA);
  return { ...p, generado: 'FIJO' };
}

/** Lo que el lector NO toca: el payload sin `consecutivo_cliente`. */
const sinConsecutivo = (p: unknown) =>
  JSON.stringify(p, (llave: string, valor: unknown) =>
    llave === 'consecutivo_cliente' ? undefined : valor,
  );

/** Ni `clave_cliente` ni claves con forma de ID o de legado. */
function esperarSinApodos(p: DineroXlsxPayload): void {
  expect(JSON.stringify(p)).not.toContain('clave_cliente');
  const todas = [
    ...p.vuelos.map((v) => v.clave),
    ...p.otros_ingresos.map((f) => f.clave),
  ];
  expect(todas.length).toBeGreaterThan(0);
  for (const c of todas) {
    expect(c).not.toMatch(FORMA_ID);
    expect(c).not.toMatch(FORMA_LEGADO);
  }
}

describe('Libro Dinero — CLAVE sin apodo (invariante 106)', () => {
  beforeEach(() => lector.mockReset());

  it('dinero-vlos: clave «#501», cliente completo y consecutivo JUNTO a la clave; ruta y fecha como siempre', async () => {
    lectorCon({ [V1]: 5 });
    const p = await libro();
    const fila = p.vuelos.find((v) => v.fecha?.startsWith('2026-09-10'))!;
    expect(fila.clave).toBe('#501');
    expect(fila.cliente).toBe('Leticia León Alvarado');
    expect(fila.consecutivo_cliente).toBe(5);
    expect(fila.ruta).toBe('cun-mid');
    expect(fila).not.toHaveProperty('servicio');
    expect(Object.keys(fila).slice(0, 3)).toEqual([
      'clave',
      'cliente',
      'consecutivo_cliente',
    ]);
    esperarSinApodos(p);
    // UNA lectura con los vuelos del periodo.
    expect(lector).toHaveBeenCalledTimes(1);
    expect([...(lector.mock.calls[0][1] as string[])].sort()).toEqual(
      [V1, V3, V4].sort(),
    );
  });

  it('multi-avión: «#503» + el sufijo de siempre « (50 % MATRÍCULA)» en cada fila, con el mismo cliente y consecutivo', async () => {
    lectorCon({ [V3]: 2 });
    const p = await libro();
    const filas = p.vuelos.filter((v) => v.clave.startsWith('#503'));
    expect(filas.map((v) => v.clave).sort()).toEqual([
      '#503 (50 % XB-DOS)',
      '#503 (50 % XB-TST)',
    ]);
    for (const f of filas) {
      expect(f.cliente).toBe('Leticia León Alvarado');
      expect(f.consecutivo_cliente).toBe(2);
    }
  });

  it("vuelo de SERVICIO ⇒ clave «#504» (ya no 'vtservicio'), cliente «Vuelo de servicio» y la bandera servicio: true", async () => {
    lectorCon({ [V4]: 9 });
    const p = await libro();
    const servicio = p.vuelos.find((v) => v.fecha?.startsWith('2026-09-18'))!;
    expect(servicio.clave).toBe('#504');
    expect(servicio.cliente).toBe(CLIENTE_VUELO_SERVICIO);
    expect(servicio.cliente).toBe('Vuelo de servicio');
    expect(servicio.servicio).toBe(true);
    expect(servicio.consecutivo_cliente).toBe(9);
    // Solo el vuelo de servicio lleva la bandera.
    expect(p.vuelos.filter((v) => v.servicio === true)).toHaveLength(1);
  });

  it('«Otros ingresos» del vuelo: «#501» + cliente, consecutivo y ruta en sus filas; ING-n sin cambio y sin esas llaves', async () => {
    lectorCon({ [V1]: 5 });
    const p = await libro();
    const delVuelo = p.otros_ingresos.filter((f) => f.fecha_vuelo != null);
    expect(delVuelo.length).toBe(3);
    for (const f of delVuelo) {
      expect(f.clave).toBe('#501');
      expect(f.cliente).toBe('Leticia León Alvarado');
      expect(f.consecutivo_cliente).toBe(5);
      expect(f.ruta).toBe('cun-mid');
    }
    const ing = p.otros_ingresos.filter((f) => f.clave.startsWith('ING-'));
    expect(ing.map((f) => f.clave)).toEqual(['ING-12', 'ING-13']);
    for (const f of ing) {
      expect(f).not.toHaveProperty('cliente');
      expect(f).not.toHaveProperty('consecutivo_cliente');
      expect(f).not.toHaveProperty('ruta');
    }
    esperarSinApodos(p);
  });

  it('sin lector ⇒ «#501» con consecutivo_cliente: null: el libro es BYTE a BYTE el golden', async () => {
    lectorCon({});
    const p = await libro(false);
    // El golden del fixture es SIN ingresos; aquí los ING-n van al final.
    const n = GOLDEN_DINERO.otros_ingresos.length;
    expect(p.vuelos.map((v) => v.clave)).toEqual(['#501']);
    expect(p.vuelos[0].consecutivo_cliente).toBeNull();
    expect(JSON.stringify(p.vuelos)).toBe(JSON.stringify(GOLDEN_DINERO.vuelos));
    expect(JSON.stringify(p.otros_ingresos.slice(0, n))).toBe(
      JSON.stringify(GOLDEN_DINERO.otros_ingresos),
    );
    esperarSinApodos(p);
  });

  it('totales y utilidades IDÉNTICOS con y sin lector (solo cambia el consecutivo)', async () => {
    lectorCon({ [V1]: 5, [V3]: 2, [V4]: 9 });
    const con = await libro();
    lectorCon({});
    const sin = await libro();
    expect(con.vuelos.length).toBe(4);
    expect(sinConsecutivo(con)).toBe(sinConsecutivo(sin));
    expect(con.utilidades_otros_ingresos_mxn).toBe(
      sin.utilidades_otros_ingresos_mxn,
    );
  });

  it('el avión de la fila no cambia (XB-TST en el #501)', async () => {
    lectorCon({ [V1]: 5 });
    const p = await libro();
    expect(p.vuelos.find((v) => v.clave === '#501')?.matricula).toBe('XB-TST');
    expect(AV).toBe('av-1');
  });
});
