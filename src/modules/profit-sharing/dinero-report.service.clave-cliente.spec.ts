// Dependencia de inyección que arrastra el cliente HTTP: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
// El lector del ID por cliente se reemplaza: aquí se prueba SOLO la
// etiqueta de la CLAVE del Libro Dinero.
jest.mock('../../common/clave-cliente-lectura.util', () => ({
  clavesClienteDeVuelos: jest.fn(),
  vueloIdsPorClaveCliente: jest.fn().mockResolvedValue([]),
}));

import { DineroReportService } from './dinero-report.service';
import { clavesClienteDeVuelos } from '../../common/clave-cliente-lectura.util';
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

/**
 * LIBRO DINERO + ID DE VUELO POR CLIENTE (13-oct-2026, API 0.0.75,
 * invariante 68). SOLO ETIQUETAS (fuente única `claveDinero`): la CLAVE de
 * la hoja de vuelos y de las filas «Otros ingresos» del vuelo pasa a ser el
 * ID («beh05-011026», + « (50 % XB-DOS)» en multi-avión); un vuelo de
 * SERVICIO sigue siendo «vtservicio»; `clave_cliente` viaja SOLO con valor.
 * Sin ID, el libro es BYTE a BYTE el de siempre (golden del fixture). Ningún
 * importe ni utilidad cambia.
 */

const lector = clavesClienteDeVuelos as jest.MockedFunction<
  typeof clavesClienteDeVuelos
>;

const AV2 = 'av-2';
const V3 = 'v-3';
const V4 = 'v-4';

function lectorCon(claves: Record<string, string>) {
  lector.mockImplementation((_sb, ids) =>
    Promise.resolve(
      new Map(
        [...new Set(ids)]
          .filter((id): id is string => !!id && claves[id] != null)
          .map((id) => [id, claves[id]] as [string, string]),
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

/** Lo que el ID NO toca: el payload sin CLAVE ni `clave_cliente`. */
const sinEtiquetas = (p: unknown) =>
  JSON.stringify(p, (llave: string, valor: unknown) =>
    llave === 'clave' || llave === 'clave_cliente' ? undefined : valor,
  );

describe('Libro Dinero — CLAVE con el ID de vuelo por cliente (invariante 68)', () => {
  beforeEach(() => lector.mockReset());

  it('dinero-vlos: la CLAVE es el ID y la fila lleva clave_cliente AL FINAL', async () => {
    lectorCon({ [V1]: 'beh05-011026' });
    const p = await libro();
    const fila = p.vuelos.find((v) => v.fecha?.startsWith('2026-09-10'))!;
    expect(fila.clave).toBe('beh05-011026');
    expect(fila.clave_cliente).toBe('beh05-011026');
    expect(Object.keys(fila).at(-1)).toBe('clave_cliente');
    // UNA lectura con los vuelos del periodo.
    expect(lector).toHaveBeenCalledTimes(1);
    expect([...(lector.mock.calls[0][1] as string[])].sort()).toEqual(
      [V1, V3, V4].sort(),
    );
  });

  it('multi-avión: el ID + el sufijo de siempre « (50 % MATRÍCULA)» en cada fila', async () => {
    lectorCon({ [V3]: 'january02-211026' });
    const p = await libro();
    const claves = p.vuelos
      .filter((v) => v.clave_cliente === 'january02-211026')
      .map((v) => v.clave)
      .sort();
    expect(claves).toEqual([
      'january02-211026 (50 % XB-DOS)',
      'january02-211026 (50 % XB-TST)',
    ]);
  });

  it("vuelo de SERVICIO ⇒ 'vtservicio' aunque tenga ID", async () => {
    lectorCon({ [V4]: 'leticia09-180926' });
    const p = await libro();
    const servicio = p.vuelos.find((v) => v.fecha?.startsWith('2026-09-18'))!;
    expect(servicio.clave).toBe('vtservicio');
  });

  it('«Otros ingresos» del vuelo: la MISMA clave en sus filas; ING-n sin cambio', async () => {
    lectorCon({ [V1]: 'beh05-011026' });
    const p = await libro();
    const delVuelo = p.otros_ingresos.filter((f) => f.fecha_vuelo != null);
    expect(delVuelo.length).toBe(3);
    for (const f of delVuelo) {
      expect(f.clave).toBe('beh05-011026');
      expect(f.clave_cliente).toBe('beh05-011026');
    }
    const ing = p.otros_ingresos.filter((f) => f.clave.startsWith('ING-'));
    expect(ing.map((f) => f.clave)).toEqual(['ING-12', 'ING-13']);
    for (const f of ing) expect(f).not.toHaveProperty('clave_cliente');
  });

  it("sin ID ⇒ 'vtleticia' y SIN llave: el libro es BYTE a BYTE el golden", async () => {
    lectorCon({});
    const p = await libro(false);
    // El golden del fixture es SIN ingresos; aquí los ING-n van al final.
    const n = GOLDEN_DINERO.otros_ingresos.length;
    expect(p.vuelos.map((v) => v.clave)).toEqual(['vtleticia']);
    expect(JSON.stringify(p.vuelos)).toBe(JSON.stringify(GOLDEN_DINERO.vuelos));
    expect(JSON.stringify(p.otros_ingresos.slice(0, n))).toBe(
      JSON.stringify(GOLDEN_DINERO.otros_ingresos),
    );
    expect(JSON.stringify(p)).not.toContain('clave_cliente');
  });

  it('totales y utilidades IDÉNTICOS con y sin ID (solo cambian las etiquetas)', async () => {
    lectorCon({ [V1]: 'beh05-011026', [V3]: 'january02-211026' });
    const con = await libro();
    lectorCon({});
    const sin = await libro();
    expect(con.vuelos.length).toBe(4);
    expect(sinEtiquetas(con)).toBe(sinEtiquetas(sin));
    expect(con.utilidades_otros_ingresos_mxn).toBe(
      sin.utilidades_otros_ingresos_mxn,
    );
  });

  it('el avión de la fila no cambia (XB-TST en el #501)', async () => {
    lectorCon({ [V1]: 'beh05-011026' });
    const p = await libro();
    expect(p.vuelos.find((v) => v.clave === 'beh05-011026')?.matricula).toBe(
      'XB-TST',
    );
    expect(AV).toBe('av-1');
  });
});
