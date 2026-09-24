import type { SupabaseClient } from '@supabase/supabase-js';
import { etiquetasFacturaDeVuelos } from './factura-cliente-etiquetas';

/**
 * Lote de etiquetas de factura para los Excel (24-sep-2026): la columna
 * «FACTURA VUELATOUR» del Libro Dinero y «factura vuelatour» del balance ya
 * no dependen SOLO de la tabla `factura` (CFDI del PAC, 0 filas en prod).
 * Se congela: la cascada en lote, sin N+1, y la tolerancia a las dos
 * migraciones pendientes (sin 500, sin pedir columnas que no existen).
 */

type Fila = Record<string, unknown>;

interface Mundo {
  factura?: Fila[];
  vuelo?: Fila[];
  /** false = 42703 al pedir `factura_estatus` (sin 20260923000001). */
  estatus?: boolean;
  /** false = 42703 al pedir `factura_folio` (sin 20260924000001). */
  folio?: boolean;
  /** error de lectura de la tabla `factura`. */
  errorFactura?: string;
}

function fake(m: Mundo) {
  const consultas: Array<{ tabla: string; select: string; ids?: unknown[] }> =
    [];
  const from = (tabla: string) => {
    let select = '';
    let ids: unknown[] | undefined;
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
    q.limit = () => q;
    q.then = (res: (v: unknown) => unknown) => {
      consultas.push({ tabla, select, ids });
      const faltante =
        tabla === 'vuelo' &&
        ((m.estatus === false && select.includes('factura_estatus')) ||
          (m.folio === false && select.includes('factura_folio')));
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

  it('EN LOTE: una consulta a `factura` y una a `vuelo` (más las sondas), nunca N+1', async () => {
    const { sb, consultas } = fake(mundo);
    await etiquetasFacturaDeVuelos(sb, [V1, V2, V3, V4, V1]);
    const deNegocio = consultas.filter((c) => c.ids);
    expect(deNegocio.map((c) => c.tabla).sort()).toEqual(['factura', 'vuelo']);
    // Ids sin repetir.
    expect(deNegocio[0].ids).toHaveLength(4);
  });

  it('más de 200 vuelos ⇒ lotes de 200 (la URL de PostgREST no crece sin tope)', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `v-${i}`);
    const { sb, consultas } = fake({ factura: [], vuelo: [] });
    await etiquetasFacturaDeVuelos(sb, ids);
    const lotes = consultas.filter((c) => c.tabla === 'vuelo' && c.ids);
    expect(lotes.map((c) => c.ids!.length)).toEqual([200, 200, 50]);
  });

  it('sin la migración del FOLIO: no lo pide y cae al estatus (el Excel sale igual que hoy)', async () => {
    const { sb, consultas } = fake({ ...mundo, folio: false });
    const m = await etiquetasFacturaDeVuelos(sb, [V2, V3]);
    expect(Object.fromEntries(m)).toEqual({
      [V2]: 'Facturado',
      [V3]: 'Facturado',
    });
    const lectura = consultas.find((c) => c.tabla === 'vuelo' && c.ids)!;
    expect(lectura.select).toBe('id, facturado, factura_estatus');
  });

  it('sin NINGUNA de las dos migraciones: solo `facturado` (CFDI)', async () => {
    const { sb, consultas } = fake({ ...mundo, estatus: false });
    const m = await etiquetasFacturaDeVuelos(sb, [V1, V3]);
    expect(Object.fromEntries(m)).toEqual({ [V1]: 'VT-501' });
    const lectura = consultas.find((c) => c.tabla === 'vuelo' && c.ids)!;
    expect(lectura.select).toBe('id, facturado');
  });

  it('sin vuelos no consulta nada', async () => {
    const { sb, consultas } = fake(mundo);
    await expect(etiquetasFacturaDeVuelos(sb, [])).resolves.toEqual(new Map());
    expect(consultas).toHaveLength(0);
  });

  it('un error REAL de lectura se lanza (nunca un libro con datos parciales)', async () => {
    const { sb } = fake({ ...mundo, errorFactura: 'timeout' });
    await expect(etiquetasFacturaDeVuelos(sb, [V1])).rejects.toThrow('timeout');
  });
});
