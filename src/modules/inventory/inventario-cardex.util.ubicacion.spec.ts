import {
  agregadosDeItem,
  bloquesCardexDe,
  cardexCronologicoDe,
  esTraspaso,
  existenciaDe,
  existenciaEnUbicacion,
  mesesCardexDe,
  resumenDiarioDe,
  statsDe,
  stockPorUbicacion,
  TEXTOS_TRASPASO,
  textoStockUbicacionInsuficiente,
  walkCardex,
  type MovCardex,
} from './inventario-cardex.util';
import {
  evaluarEliminacion,
  type MovEliminable,
} from './eliminar-movimiento.util';

/**
 * STOCK POR UBICACIÓN Y TRASPASOS (27-oct-2026, invariante 111). Caso de la
 * oficina: el filtro CH48108 vive en dos bodegas. Cardex: entrada de 3 del
 * 01-sep (sin bodega ⇒ la principal, Bodega Corner), salida de 2 el mismo
 * día (sin bodega), entrada de 1 el 26-oct EN Locker Toledo y un traspaso de
 * 1 de la principal a Toledo el 27-oct. Existencia total 2: Corner 0 ·
 * Toledo 2.
 */
const CORNER = 'loc-corner';
const TOLEDO = 'loc-toledo';

function ent(
  id: string,
  cantidad: number,
  fecha: string,
  extra: Partial<MovCardex> = {},
): MovCardex {
  return {
    id,
    tipo: 'ENTRADA',
    cantidad,
    costo_unitario_usd: 46.06,
    moneda: 'USD',
    costo_unitario_mxn: null,
    tc_usd_mxn: 17.0077,
    fecha_movimiento: fecha,
    created_at: `${fecha}T15:00:00Z`,
    ...extra,
  };
}

function sal(
  id: string,
  cantidad: number,
  fecha: string,
  extra: Partial<MovCardex> = {},
): MovCardex {
  return {
    id,
    tipo: 'SALIDA',
    cantidad,
    costo_unitario_usd: 46.06,
    moneda: 'USD',
    costo_unitario_mxn: null,
    tc_usd_mxn: 17.0077,
    venta_unitaria: 57.575,
    venta_moneda: 'USD',
    fecha_movimiento: fecha,
    created_at: `${fecha}T18:00:00Z`,
    aeronave_id: 'a-n4142r',
    aeronave: { matricula: 'N4142R' },
    ...extra,
  };
}

function tras(
  id: string,
  cantidad: number,
  fecha: string,
  origen: string | null,
  destino: string,
  extra: Partial<MovCardex> = {},
): MovCardex {
  return {
    id,
    tipo: 'TRASPASO',
    cantidad,
    costo_unitario_usd: 0,
    moneda: 'USD',
    costo_unitario_mxn: null,
    tc_usd_mxn: null,
    fecha_movimiento: fecha,
    created_at: `${fecha}T12:00:00Z`,
    ubicacion_id: origen,
    ubicacion_destino_id: destino,
    ubicacion: origen === CORNER ? { nombre: 'Bodega Corner' } : null,
    ubicacion_destino: { nombre: 'Locker Toledo' },
    ...extra,
  };
}

const E1 = ent('E1', 3, '2026-09-01');
const S1 = sal('S1', 2, '2026-09-01');
const E2 = ent('E2', 1, '2026-10-26', { ubicacion_id: TOLEDO });
const T1 = tras('T1', 1, '2026-10-27', null, TOLEDO);
const MOVS = [T1, E2, S1, E1];

describe('stockPorUbicacion — la existencia por bodega sale del cardex (invariante 111)', () => {
  it('CH48108: Corner 0 · Toledo 2; Σ == existencia total; lo sin bodega cuenta en la principal', () => {
    expect(esTraspaso(T1)).toBe(true);
    expect(esTraspaso(E1)).toBe(false);
    expect(existenciaDe(MOVS)).toBe(2);
    expect(stockPorUbicacion(MOVS, CORNER)).toEqual([
      { ubicacion_id: CORNER, cantidad: 0 },
      { ubicacion_id: TOLEDO, cantidad: 2 },
    ]);
    expect(existenciaEnUbicacion(MOVS, CORNER, TOLEDO)).toBe(2);
    expect(existenciaEnUbicacion(MOVS, CORNER, CORNER)).toBe(0);
    expect(existenciaEnUbicacion(MOVS, CORNER, 'otra')).toBe(0);
  });

  it('sin principal, lo sin bodega es «Sin ubicación» (null); cambiar la principal re-etiqueta todo lo sin bodega', () => {
    expect(stockPorUbicacion(MOVS, null)).toEqual([
      { ubicacion_id: null, cantidad: 0 },
      { ubicacion_id: TOLEDO, cantidad: 2 },
    ]);
    // Con la principal en Toledo TODO cae ahí: 3 − 2 + 1 (traspaso de
    // Toledo a Toledo: −1 + 1).
    expect(stockPorUbicacion(MOVS, TOLEDO)).toEqual([
      { ubicacion_id: TOLEDO, cantidad: 2 },
    ]);
    expect(stockPorUbicacion([], CORNER)).toEqual([]);
  });

  it('un traspaso que saca más de lo que hay deja la bodega en negativo (se VE; la captura lo impide con 409)', () => {
    const t2 = tras('T2', 5, '2026-10-28', CORNER, TOLEDO);
    expect(stockPorUbicacion([...MOVS, t2], CORNER)).toEqual([
      { ubicacion_id: CORNER, cantidad: -5 },
      { ubicacion_id: TOLEDO, cantidad: 7 },
    ]);
    expect(existenciaDe([...MOVS, t2])).toBe(2);
  });
});

describe('los lectores de existencia, costo y utilidad SALTAN el traspaso', () => {
  it('existencia, valorizado, agregados, resumen por día y por mes no cambian con el traspaso', () => {
    const sinTraspaso = [E2, S1, E1];
    expect(existenciaDe(MOVS)).toBe(existenciaDe(sinTraspaso));
    const st = statsDe(MOVS, { hoy: '2026-10-27', tcHoy: 17.0077 });
    expect(st.stock).toBe(2);
    expect(st.costo_vigente?.movimiento_id).toBe('E2');
    expect(agregadosDeItem(MOVS)).toEqual(agregadosDeItem(sinTraspaso));
    expect(resumenDiarioDe(MOVS).map((d) => d.fecha)).toEqual([
      '2026-09-01',
      '2026-10-26',
    ]);
    const oct = mesesCardexDe(MOVS, { hoy: '2026-10-27' }).find(
      (m) => m.mes === '2026-10',
    );
    expect(oct).toMatchObject({
      stock_inicio: 1,
      entradas: 1,
      unidades_vendidas: 0,
      stock_final: 2,
      movimientos: 1,
    });
  });

  it('walkCardex: el traspaso es un paso SIN cambio de stock ni costo', () => {
    const w = walkCardex(MOVS);
    expect(w.get('T1')).toEqual({
      stockDespues: 2,
      costoMxn: null,
      costoUsd: null,
      sinTc: false,
    });
    expect(w.get('E2')?.stockDespues).toBe(2);
  });

  it('bloquesCardexDe lista los traspasos aparte (con su orden) y cardexCronologicoDe los pinta sin entra/sale ni montos', () => {
    const b = bloquesCardexDe('Filtro CH48108', MOVS, undefined, {
      hoy: '2026-10-27',
    });
    expect(b.compras.map((c) => c.movimiento_id)).toEqual(['E1', 'E2']);
    expect(b.ventas.map((v) => v.movimiento_id)).toEqual(['S1']);
    expect(b.traspasos).toEqual([
      {
        movimiento_id: 'T1',
        orden: 3,
        fecha: '2026-10-27',
        cantidad: 1,
        origen_id: null,
        origen_nombre: null,
        destino_id: TOLEDO,
        destino_nombre: 'Locker Toledo',
        referencia: null,
        stock_despues: 2,
      },
    ]);
    expect(b.totales.compras_cant).toBe(4);
    const filas = cardexCronologicoDe(b);
    expect(filas.map((f) => [f.tipo, f.existencia])).toEqual([
      ['ENTRADA', 3],
      ['SALIDA', 1],
      ['ENTRADA', 2],
      ['TRASPASO', 2],
    ]);
    expect(filas[3]).toMatchObject({
      movimiento_id: 'T1',
      mes: '2026-10',
      entra: null,
      sale: null,
      detalle: 'Traspaso de 1 · ubicación principal → Locker Toledo',
      precio_unitario_mxn: null,
      total_mxn: null,
      ganancia_mxn: null,
      a_costo: false,
    });
    // Con origen nombrado y referencia.
    const b2 = bloquesCardexDe('Filtro', [
      E1,
      tras('T9', 1, '2026-10-28', CORNER, TOLEDO, { referencia: 'guía 7' }),
    ]);
    expect(cardexCronologicoDe(b2)[1].detalle).toBe(
      'Traspaso de 1 · Bodega Corner → Locker Toledo · ref guía 7',
    );
  });

  it('un TRASPASO no se elimina: TIPO_NO_SOPORTADO con el texto del traspaso contrario; la simulación lo ignora', () => {
    const movs: MovEliminable[] = MOVS.map((m) => ({ ...m, id: m.id! }));
    const r = evaluarEliminacion(movs, 'T1', '2026-10-27');
    expect(r.permitido).toBe(false);
    expect(r.codigo_bloqueo).toBe('TIPO_NO_SOPORTADO');
    expect(r.detalle).toContain('registra el traspaso contrario');
    expect(r.stock_antes).toBe(2);
    expect(r.stock_despues).toBe(2);
    // Quitar la ENTRADA de Toledo sigue siendo posible: el traspaso no
    // cuenta en la simulación de stock.
    expect(evaluarEliminacion(movs, 'E2', '2026-10-27').stock_despues).toBe(1);
  });
});

describe('textos del 409 y de los 400 (es-MX)', () => {
  it('STOCK_UBICACION_INSUFICIENTE dice dónde está el stock', () => {
    expect(
      textoStockUbicacionInsuficiente({
        accion: 'salida',
        ubicacion: 'Locker Toledo',
        disponible: 5,
        solicitado: 8,
        reparto: [
          { nombre: 'Bodega Corner', cantidad: 95 },
          { nombre: 'Locker Toledo', cantidad: 5 },
          { nombre: null, cantidad: 2 },
          { nombre: 'Taller Merida', cantidad: 0 },
        ],
      }),
    ).toBe(
      'En Locker Toledo hay 5 y la salida pide 8. Dónde está: Bodega Corner 95 · Locker Toledo 5 · Sin ubicación 2. Elige otra bodega o registra un traspaso.',
    );
    expect(
      textoStockUbicacionInsuficiente({
        accion: 'traspaso',
        ubicacion: null,
        disponible: 0,
        solicitado: 1,
        reparto: [],
      }),
    ).toBe(
      'En la ubicación principal hay 0 y el traspaso pide 1. Este producto no tiene existencia en ninguna bodega. Elige otra bodega o registra un traspaso.',
    );
  });

  it('TEXTOS_TRASPASO', () => {
    expect(TEXTOS_TRASPASO.sinDestino).toContain('ubicacion_destino_id');
    expect(TEXTOS_TRASPASO.mismoOrigen('Bodega Corner')).toContain(
      '(Bodega Corner)',
    );
    expect(TEXTOS_TRASPASO.destinoSoloTraspaso).toContain('traspaso');
  });
});
