import {
  MANT_HITO_COLS,
  NOTA_SERVICIO_AUTOMATICO,
  VENTANA_ANTICIPO_HR,
  esServicioDelAvion,
  hitoAnclado,
  hitoAtendido,
  hitoPendienteDeOrden,
  hitoYaTieneOrden,
  intervalosEnHito,
  mantenimientoCubreHito,
  mantenimientoQueCubreHito,
  ordenAbiertaDelHito,
  ordenDeServicio,
  ordenEsAutomatica,
  ordenEstaAbierta,
  posicionAtendida,
  servicioHecho,
  siguienteHitoDespuesDe,
  ultimoHitoAtendido,
  type MantenimientoHitoRow,
} from './servicio-hito.util';
import {
  FLOTA_REAL_17_NOV,
  N4142R,
  N58BT,
  N621TX,
  N990GG,
  XA_VGV,
  XB_ANU,
  XB_PEV,
  type AvionReal,
} from './servicio-hito.flota-real.fixture-spec';

/**
 * Caso real que motivó todo (XA-VGV, 19-sep-2026): el avión cruzó el umbral
 * de 10 h a las 08:40 y la orden del hito 2,250 no existía. El dedupe y la
 * tarjeta tienen que ver EXACTAMENTE lo mismo: si difieren, o se duplica una
 * orden o nunca se crea ninguna.
 */
const HITO = { a_las: 2250, intervalo: 50 };

describe('mantenimientoCubreHito — dedupe del programa de servicio', () => {
  it('mismo hito por horas programadas (±0.05) cubre en CUALQUIER estado', () => {
    for (const estado of ['PROGRAMADO', 'EN_TALLER', 'COMPLETADO']) {
      expect(
        mantenimientoCubreHito(
          { id: 'm', estado, horas_programadas: 2250 },
          HITO,
        ),
      ).toBe(true);
    }
    // Tolerancia: 2249.98 es el mismo hito; 2250.2 es otro.
    expect(
      mantenimientoCubreHito({ id: 'm', horas_programadas: 2249.98 }, HITO),
    ).toBe(true);
    expect(
      mantenimientoCubreHito({ id: 'm', horas_programadas: 2250.2 }, HITO),
    ).toBe(false);
  });

  it('numeric de Postgres llega como string y se compara igual', () => {
    expect(
      mantenimientoCubreHito({ id: 'm', horas_programadas: '2250.0' }, HITO),
    ).toBe(true);
  });

  it('servicio de la MISMA etapa ya HECHO un poco antes del hito (sin horas programadas) cubre el hito', () => {
    // Entró a 2,243 h, 7 h antes: dentro de [2250 − 10, 2250] ⇒ cubierto.
    expect(
      mantenimientoCubreHito(
        {
          id: 'm',
          estado: 'COMPLETADO',
          etapa_intervalo_hr: 50,
          horas_aeronave: 2243,
          fecha_realizada: '2026-09-01',
        },
        HITO,
      ),
    ).toBe(true);
    // Entró a 2,210 h, 40 h antes: es el servicio de 2,200 hecho TARDE, no el
    // de 2,250. Hasta el 17-nov-2026 esto «cubría» (bastaba caer dentro del
    // ciclo (2200, 2250]) y la orden de 2,250 no se creaba nunca: es el
    // defecto del N4142R (invariante 138).
    expect(
      mantenimientoCubreHito(
        {
          id: 'm',
          estado: 'COMPLETADO',
          etapa_intervalo_hr: 50,
          horas_aeronave: 2210,
          fecha_realizada: '2026-09-01',
        },
        HITO,
      ),
    ).toBe(false);
    // Entró ANTES del ciclo actual (2,190 h): no cubre este hito.
    expect(
      mantenimientoCubreHito(
        {
          id: 'm',
          estado: 'COMPLETADO',
          etapa_intervalo_hr: 50,
          horas_aeronave: 2190,
          fecha_realizada: '2026-07-01',
        },
        HITO,
      ),
    ).toBe(false);
    // Etapa distinta (200 h): no cubre el de 50 h.
    expect(
      mantenimientoCubreHito(
        {
          id: 'm',
          estado: 'COMPLETADO',
          etapa_intervalo_hr: 200,
          horas_aeronave: 2210,
          fecha_realizada: '2026-09-01',
        },
        HITO,
      ),
    ).toBe(false);
    // Completado sin horas capturadas: no se puede afirmar que cubra.
    expect(
      mantenimientoCubreHito(
        {
          id: 'm',
          estado: 'COMPLETADO',
          etapa_intervalo_hr: 50,
          horas_aeronave: null,
          fecha_realizada: '2026-09-01',
        },
        HITO,
      ),
    ).toBe(false);
  });

  it('regla 2: la ventana es de 10 h (VENTANA_ANTICIPO_HR) con media décima de tolerancia en los dos bordes', () => {
    const hecho = (horas_aeronave: number): MantenimientoHitoRow => ({
      id: `h-${horas_aeronave}`,
      estado: 'COMPLETADO',
      etapa_intervalo_hr: 50,
      horas_aeronave,
      fecha_realizada: '2026-09-01',
    });
    expect(VENTANA_ANTICIPO_HR).toBe(10);
    expect(mantenimientoCubreHito(hecho(2240), HITO)).toBe(true);
    expect(mantenimientoCubreHito(hecho(2239.9), HITO)).toBe(false);
    expect(mantenimientoCubreHito(hecho(2250), HITO)).toBe(true);
    // Después del hito ya no «cubre» por esta regla (como siempre: el tope
    // superior no cambió); quien lo da por atendido es `hitoAtendido`.
    expect(mantenimientoCubreHito(hecho(2250.1), HITO)).toBe(false);
  });

  it('regla 2: una fila CON horas programadas pertenece a ESE número — solo cubre por la regla 1', () => {
    // El «50 hrs» programado a 2,200 y hecho tardísimo, a 2,245 h: cae dentro
    // de la ventana de anticipo de 2,250, pero declara que es el de 2,200.
    const tardio: MantenimientoHitoRow = {
      id: 'm',
      estado: 'COMPLETADO',
      horas_programadas: 2200,
      etapa_intervalo_hr: 50,
      horas_aeronave: 2245,
      fecha_realizada: '2026-09-01',
    };
    expect(mantenimientoCubreHito(tardio, HITO)).toBe(false);
    expect(mantenimientoCubreHito(tardio, { a_las: 2200, intervalo: 50 })).toBe(
      true,
    );
  });

  it('entrada MANUAL abierta de la misma etapa SIN horas también cubre', () => {
    expect(
      mantenimientoCubreHito(
        {
          id: 'm',
          estado: 'PROGRAMADO',
          horas_programadas: null,
          etapa_intervalo_hr: 50,
        },
        HITO,
      ),
    ).toBe(true);
    // Sin horas y sin etapa: no se puede atribuir a este hito.
    expect(
      mantenimientoCubreHito(
        { id: 'm', estado: 'PROGRAMADO', horas_programadas: null },
        HITO,
      ),
    ).toBe(false);
  });

  it('hitoYaTieneOrden / mantenimientoQueCubreHito leen la misma regla', () => {
    const mants: MantenimientoHitoRow[] = [
      { id: 'otro', horas_programadas: 2200 },
      { id: 'este', horas_programadas: 2250 },
    ];
    expect(hitoYaTieneOrden(mants, HITO)).toBe(true);
    expect(mantenimientoQueCubreHito(mants, HITO)?.id).toBe('este');
    expect(hitoYaTieneOrden([], HITO)).toBe(false);
    expect(mantenimientoQueCubreHito([], HITO)).toBeNull();
  });
});

describe('ordenDeServicio — lo que ve el operador en la tarjeta', () => {
  it('PROGRAMADO sin fecha (como nace la automática)', () => {
    expect(
      ordenDeServicio({
        id: 'm1',
        estado: 'PROGRAMADO',
        fecha_programada: null,
        notas: `${NOTA_SERVICIO_AUTOMATICO} por el programa de servicio: faltan 9.8 h…`,
      }),
    ).toEqual({
      id: 'm1',
      estado: 'PROGRAMADO',
      fecha_programada: null,
      automatica: true,
    });
  });

  it('la orden que levantó el mecánico a mano NO es automática', () => {
    expect(
      ordenEsAutomatica({ id: 'm', notas: 'Servicio 50 hrs XA-VGV' }),
    ).toBe(false);
    expect(ordenEsAutomatica({ id: 'm', notas: null })).toBe(false);
  });

  it('EN_TALLER y fecha confirmada viajan tal cual', () => {
    expect(
      ordenDeServicio({
        id: 'm2',
        estado: 'EN_TALLER',
        fecha_programada: '2026-09-25',
      }),
    ).toEqual({
      id: 'm2',
      estado: 'EN_TALLER',
      fecha_programada: '2026-09-25',
      automatica: false,
    });
  });

  it('una orden CERRADA no es orden pendiente (null)', () => {
    expect(ordenDeServicio({ id: 'm3', estado: 'COMPLETADO' })).toBeNull();
    expect(
      ordenDeServicio({ id: 'm4', fecha_realizada: '2026-09-01' }),
    ).toBeNull();
    expect(ordenDeServicio(null)).toBeNull();
  });

  it('fila legada SIN estado cuenta como PROGRAMADO abierta', () => {
    expect(ordenEstaAbierta({ id: 'm5' })).toBe(true);
    expect(ordenDeServicio({ id: 'm5' })?.estado).toBe('PROGRAMADO');
  });
});

describe('ordenAbiertaDelHito', () => {
  it('sin orden abierta del hito ⇒ null (aunque haya una completada)', () => {
    expect(
      ordenAbiertaDelHito(
        [
          { id: 'viejo', estado: 'COMPLETADO', horas_programadas: 2250 },
          { id: 'ajeno', estado: 'PROGRAMADO', horas_programadas: 2400 },
        ],
        HITO,
      ),
    ).toBeNull();
  });

  it('caso XA-VGV: la orden manual del hito 2,250 SÍ aparece en la tarjeta', () => {
    expect(
      ordenAbiertaDelHito(
        [
          {
            id: 'porfirio',
            estado: 'PROGRAMADO',
            horas_programadas: 2250,
            fecha_programada: null,
            notas: null,
          },
        ],
        HITO,
      ),
    ).toEqual({
      id: 'porfirio',
      estado: 'PROGRAMADO',
      fecha_programada: null,
      automatica: false,
    });
  });

  it('con varias candidatas gana la más avanzada (EN_TALLER > con fecha > sin fecha)', () => {
    const mants: MantenimientoHitoRow[] = [
      { id: 'c', estado: 'PROGRAMADO', horas_programadas: 2250 },
      {
        id: 'b',
        estado: 'PROGRAMADO',
        horas_programadas: 2250,
        fecha_programada: '2026-09-25',
      },
      { id: 'a', estado: 'EN_TALLER', horas_programadas: 2250 },
    ];
    expect(ordenAbiertaDelHito(mants, HITO)?.id).toBe('a');
    expect(ordenAbiertaDelHito(mants.slice(0, 2), HITO)?.id).toBe('b');
  });
});

describe('MANT_HITO_COLS', () => {
  it('trae TODO lo que la regla mira (si falta una, el dedupe miente)', () => {
    for (const col of [
      'id',
      'estado',
      'horas_programadas',
      'etapa_intervalo_hr',
      'fecha_realizada',
      'fecha_programada',
      'horas_aeronave',
      'notas',
      // 27-oct-2026: el hito pendiente deja fuera los overhauls de componente.
      'motor_id',
      'helice_id',
    ]) {
      expect(MANT_HITO_COLS.split(', ')).toContain(col);
    }
    // Sin repetidos: PostgREST no agradece `motor_id` dos veces en el select.
    const cols = MANT_HITO_COLS.split(', ');
    expect(new Set(cols).size).toBe(cols.length);
  });
});

// ───────── Hito PENDIENTE: el programa no brinca (27-oct-2026, inv. 108) ─────────

/**
 * Pedido del cliente (27-oct-2026, capturas de la lista de flota y de la
 * orden): «la app marca cuánto tiempo le falta para el siguiente servicio,
 * pero cuando no se pudo llevar en tiempo y forma se brinca al siguiente
 * servicio; que tenga un contador negativo hasta que se marque de concluido
 * el servicio de mantenimiento». Datos REALES de prod ese día: XA-VGV con
 * programa [50,100,200,500] base 1,750, tacómetro 2,264.2, la orden del hito
 * 2,250 («Servicio 500 hrs», PROGRAMADA para el 23-oct) sin cerrar — y la
 * lista decía «faltan 39.3 h» al hito de 2,300.
 */
const PROGRAMA_VGV = { intervalos: [50, 100, 200, 500], base: 1750 };
const ORDEN_2250: MantenimientoHitoRow = {
  id: 'af81ccf5',
  estado: 'PROGRAMADO',
  horas_programadas: '2250',
  etapa_intervalo_hr: '500.00',
  fecha_programada: '2026-10-23',
  fecha_realizada: null,
  horas_aeronave: null,
  notas: null,
  motor_id: null,
  helice_id: null,
};
const HECHO_50_2216: MantenimientoHitoRow = {
  id: '181bd2c0',
  estado: 'COMPLETADO',
  horas_programadas: '2212',
  etapa_intervalo_hr: '50.00',
  horas_aeronave: '2216.9',
  fecha_realizada: '2026-08-28',
};
const HECHO_200_2162: MantenimientoHitoRow = {
  id: 'f3141a74',
  estado: 'COMPLETADO',
  horas_aeronave: '2162.7',
  fecha_realizada: '2026-07-10',
};
const MANTS_VGV = [HECHO_200_2162, HECHO_50_2216, ORDEN_2250];

const pendienteVgv = (
  horas: number,
  mantenimientos: readonly MantenimientoHitoRow[] = MANTS_VGV,
) => hitoPendienteDeOrden({ mantenimientos, ...PROGRAMA_VGV, horas });

describe('intervalosEnHito', () => {
  it('2,250 con base 1,750: caen 50, 100 y 500 (200 no: 500/200 no es entero)', () => {
    expect(intervalosEnHito([50, 100, 200, 500], 1750, 2250)).toEqual([
      50, 100, 500,
    ]);
  });

  it('un número fuera del programa (2,212) no es hito; la base tampoco (k ≥ 1)', () => {
    expect(intervalosEnHito([50, 100, 200, 500], 1750, 2212)).toEqual([]);
    expect(intervalosEnHito([50], 1750, 1750)).toEqual([]);
  });

  it('tolera la aritmética decimal (XB-ANU: 1,253.9 + 100) y el numeric en string', () => {
    expect(intervalosEnHito([50, 100, 200, 500], '1253.9', 1353.9)).toEqual([
      50, 100,
    ]);
  });

  it('intervalos basura o repetidos se limpian; sin programa, vacío', () => {
    expect(intervalosEnHito([50, 50, 0, -1, 'x'], 1750, 1800)).toEqual([50]);
    expect(intervalosEnHito([], 0, 100)).toEqual([]);
  });
});

describe('hitoPendienteDeOrden — una orden abierta ya alcanzada sostiene el hito', () => {
  it('XA-VGV a 2,264.2 h: la orden PROGRAMADA de 2,250 (500 hrs) ES el próximo servicio', () => {
    const p = pendienteVgv(2264.2);
    expect(p).toMatchObject({
      a_las: 2250,
      intervalo: 500,
      etapas_incluidas: [50, 100, 500],
    });
    expect(p?.orden.id).toBe('af81ccf5');
  });

  it('a 2,240.2 h (hito todavía adelante) no hay pendiente: manda el programa cíclico', () => {
    expect(pendienteVgv(2240.2)).toBeNull();
  });

  it('en el hito exacto (±0.05) ya cuenta como alcanzado; media décima antes, no', () => {
    expect(pendienteVgv(2249.97)?.a_las).toBe(2250);
    expect(pendienteVgv(2249.9)).toBeNull();
  });

  it('al marcar la orden COMPLETADO el programa avanza (ya no hay pendiente)', () => {
    const cerrada: MantenimientoHitoRow = {
      ...ORDEN_2250,
      estado: 'COMPLETADO',
      horas_aeronave: 2270,
      fecha_realizada: '2026-10-28',
    };
    expect(pendienteVgv(2275, [HECHO_50_2216, cerrada])).toBeNull();
  });

  it('orden huérfana: el servicio quedó HECHO en otra fila de la MISMA etapa (tarde) ⇒ atendido', () => {
    const hechoAparte: MantenimientoHitoRow = {
      id: 'app-1',
      estado: 'COMPLETADO',
      etapa_intervalo_hr: 500,
      horas_aeronave: 2262,
      fecha_realizada: '2026-10-27',
    };
    expect(pendienteVgv(2264.2, [...MANTS_VGV, hechoAparte])).toBeNull();
  });

  it('un servicio hecho de una etapa MENOR no atiende el hito grande (el de 50 no es el de 500)', () => {
    // El «50 hrs» de 2,216.9 ya está en MANTS_VGV y no basta.
    expect(pendienteVgv(2264.2)?.a_las).toBe(2250);
  });

  it('un hecho SIN etapa ni horas programadas no se puede atribuir: la orden sigue pendiente', () => {
    const sinEtapa: MantenimientoHitoRow = {
      id: 'libre',
      estado: 'COMPLETADO',
      horas_aeronave: 2262,
      fecha_realizada: '2026-10-27',
    };
    expect(pendienteVgv(2264.2, [...MANTS_VGV, sinEtapa])?.a_las).toBe(2250);
  });

  it('N58BT (caso real 22-sep): orden EN_TALLER de 1,600 con el taco en 1,627.2 ⇒ pendiente 1,600, no 1,700', () => {
    const p = hitoPendienteDeOrden({
      mantenimientos: [
        {
          id: 'm-taller',
          estado: 'EN_TALLER',
          horas_programadas: 1600,
          horas_aeronave: 1627.2,
          fecha_programada: '2026-08-13',
        },
        { id: 'm-hsi', estado: 'PROGRAMADO', horas_programadas: 1800 },
      ],
      intervalos: [100],
      base: 1500,
      horas: 1627.2,
    });
    expect(p).toMatchObject({
      a_las: 1600,
      intervalo: 100,
      etapas_incluidas: [100],
    });
    expect(p?.orden.id).toBe('m-taller');
  });

  it('con dos órdenes vencidas manda la de horas más bajas (lo más atrasado primero); a igualdad, id menor', () => {
    const programa = { intervalos: [50, 100, 500, 1000], base: 5500 };
    const p = hitoPendienteDeOrden({
      mantenimientos: [
        { id: 'b', estado: 'PROGRAMADO', horas_programadas: 5650 },
        { id: 'a', estado: 'PROGRAMADO', horas_programadas: 5600 },
      ],
      ...programa,
      horas: 5660,
    });
    expect(p).toMatchObject({ a_las: 5600, intervalo: 100 });
    const empate = hitoPendienteDeOrden({
      mantenimientos: [
        { id: 'z', estado: 'PROGRAMADO', horas_programadas: 5600 },
        { id: 'a', estado: 'PROGRAMADO', horas_programadas: 5600 },
      ],
      ...programa,
      horas: 5605,
    });
    expect(empate?.orden.id).toBe('a');
  });

  it('orden fuera del programa pero de una etapa del programa (2,212 h, etapa 50) va por su etapa', () => {
    const p = hitoPendienteDeOrden({
      mantenimientos: [
        {
          id: 'manual',
          estado: 'PROGRAMADO',
          horas_programadas: 2212,
          etapa_intervalo_hr: 50,
        },
      ],
      ...PROGRAMA_VGV,
      horas: 2220,
    });
    expect(p).toMatchObject({
      a_las: 2212,
      intervalo: 50,
      etapas_incluidas: [50],
    });
  });

  it('lo que NO sostiene el programa: componente, sin horas, fuera del programa sin etapa, sin programa', () => {
    expect(
      pendienteVgv(2264.2, [{ ...ORDEN_2250, motor_id: 'motor-1' }]),
    ).toBeNull();
    expect(
      pendienteVgv(2264.2, [{ ...ORDEN_2250, helice_id: 'helice-1' }]),
    ).toBeNull();
    expect(
      pendienteVgv(2264.2, [{ ...ORDEN_2250, horas_programadas: null }]),
    ).toBeNull();
    expect(
      pendienteVgv(2264.2, [
        { id: 'llanta', estado: 'PROGRAMADO', horas_programadas: 2230 },
      ]),
    ).toBeNull();
    expect(
      hitoPendienteDeOrden({
        mantenimientos: MANTS_VGV,
        intervalos: [],
        base: 0,
        horas: 2264.2,
      }),
    ).toBeNull();
  });

  it('XB-ANU: sin ninguna orden no se inventa un vencido (el historial sin capturar no se castiga)', () => {
    expect(
      hitoPendienteDeOrden({
        mantenimientos: [],
        intervalos: [50, 100, 200, 500],
        base: 1253.9,
        horas: 1381.6,
      }),
    ).toBeNull();
  });

  it('fila legada sin `estado` cuenta como abierta (igual que ordenEstaAbierta)', () => {
    expect(
      pendienteVgv(2264.2, [{ id: 'legada', horas_programadas: 2250 }])?.a_las,
    ).toBe(2250);
  });

  it('sin tacómetro (horas no finitas) no se afirma nada', () => {
    expect(pendienteVgv(Number.NaN)).toBeNull();
  });

  it('la orden pendiente es la MISMA que ordenAbiertaDelHito pinta en la tarjeta', () => {
    const p = pendienteVgv(2264.2);
    expect(ordenAbiertaDelHito(MANTS_VGV, p!)).toEqual({
      id: 'af81ccf5',
      estado: 'PROGRAMADO',
      fecha_programada: '2026-10-23',
      automatica: false,
    });
  });
});

describe('hitoAtendido', () => {
  const hito = { a_las: 2250, intervalo: 50 };

  it('regla 1: la orden del hito COMPLETADA (horas programadas) atiende, con cualquier etapa', () => {
    expect(
      hitoAtendido(
        [
          {
            id: 'm',
            estado: 'COMPLETADO',
            horas_programadas: '2250.0',
            etapa_intervalo_hr: 500,
          },
        ],
        hito,
      ),
    ).toBe(true);
  });

  it('regla (b) sin horas programadas: misma etapa hecha un poco antes (≤ 10 h) O DESPUÉS del hito', () => {
    const hecho = (horas_aeronave: number): MantenimientoHitoRow => ({
      id: `h-${horas_aeronave}`,
      estado: 'COMPLETADO',
      etapa_intervalo_hr: 50,
      horas_aeronave,
      fecha_realizada: '2026-10-01',
    });
    // 7 h antes y 12 h después: es el servicio de este hito.
    expect(hitoAtendido([hecho(2243)], hito)).toBe(true);
    expect(hitoAtendido([hecho(2262)], hito)).toBe(true);
    // Justo en el borde de la ventana (10 h antes) todavía cuenta.
    expect(hitoAtendido([hecho(2240)], hito)).toBe(true);
    // 33 h antes: es el de 2,200 hecho TARDE, no el de 2,250. Hasta el
    // 17-nov-2026 atendía (bastaba `horas > hito − intervalo`): el defecto
    // del N4142R (invariante 138).
    expect(hitoAtendido([hecho(2216.9)], hito)).toBe(false);
    expect(hitoAtendido([hecho(2239.9)], hito)).toBe(false);
    // Antes del ciclo (≤ 2,200): es de otro hito.
    expect(hitoAtendido([hecho(2200)], hito)).toBe(false);
  });

  it('regla (b) CON horas programadas: la fila declara su hito — atiende si es de este hito o de uno posterior', () => {
    const declarado = (
      horas_programadas: number,
      horas_aeronave: number,
    ): MantenimientoHitoRow => ({
      id: `d-${horas_programadas}`,
      estado: 'COMPLETADO',
      etapa_intervalo_hr: 50,
      horas_programadas,
      horas_aeronave,
      fecha_realizada: '2026-10-01',
    });
    // Un «50 hrs» posterior (2,300) ya hecho deja atrás la orden de 2,250.
    expect(hitoAtendido([declarado(2300, 2301)], hito)).toBe(true);
    // El del ciclo ANTERIOR (2,200) hecho tardísimo, a 2,248 h —dentro de la
    // ventana de anticipo de 2,250—, NO atiende: pertenece a su número.
    expect(hitoAtendido([declarado(2200, 2248)], hito)).toBe(false);
    expect(hitoAtendido([declarado(2200, 2262)], hito)).toBe(false);
  });

  it('N4142R (prod 17-nov-2026): el servicio de 4,400 hecho a 4,406 YA NO atiende el hito de 4,500', () => {
    const hito4500 = { a_las: 4500, intervalo: 100 };
    expect(hitoAtendido(N4142R.mantenimientos, hito4500)).toBe(false);
    // Y con su orden completada, sí (regla a).
    expect(
      hitoAtendido(
        [
          ...N4142R.mantenimientos,
          {
            id: 'orden-4500',
            estado: 'COMPLETADO',
            horas_programadas: 4500,
            etapa_intervalo_hr: 100,
            horas_aeronave: 4506,
            fecha_realizada: '2026-11-19',
          },
        ],
        hito4500,
      ),
    ).toBe(true);
  });

  it('lo que no atiende: etapa distinta, sin horas, abierta, de componente', () => {
    expect(
      hitoAtendido(
        [
          {
            id: 'a',
            estado: 'COMPLETADO',
            etapa_intervalo_hr: 100,
            horas_aeronave: 2262,
          },
        ],
        hito,
      ),
    ).toBe(false);
    expect(
      hitoAtendido(
        [
          {
            id: 'b',
            estado: 'COMPLETADO',
            etapa_intervalo_hr: 50,
            horas_aeronave: null,
          },
        ],
        hito,
      ),
    ).toBe(false);
    expect(
      hitoAtendido(
        [
          {
            id: 'c',
            estado: 'EN_TALLER',
            horas_programadas: 2250,
            etapa_intervalo_hr: 50,
            horas_aeronave: 2262,
          },
        ],
        hito,
      ),
    ).toBe(false);
    expect(
      hitoAtendido(
        [
          {
            id: 'd',
            estado: 'COMPLETADO',
            horas_programadas: 2250,
            motor_id: 'motor-1',
          },
        ],
        hito,
      ),
    ).toBe(false);
    expect(hitoAtendido([], hito)).toBe(false);
  });

  it('servicioHecho es el complemento exacto de ordenEstaAbierta; esServicioDelAvion mira motor/hélice', () => {
    for (const m of [
      { id: '1', estado: 'COMPLETADO' },
      { id: '2', fecha_realizada: '2026-10-01' },
      { id: '3', estado: 'PROGRAMADO' },
      { id: '4' },
    ] as MantenimientoHitoRow[]) {
      expect(servicioHecho(m)).toBe(!ordenEstaAbierta(m));
    }
    expect(esServicioDelAvion({ id: 'x' })).toBe(true);
    expect(
      esServicioDelAvion({ id: 'x', motor_id: null, helice_id: null }),
    ).toBe(true);
    expect(esServicioDelAvion({ id: 'x', motor_id: 'm' })).toBe(false);
    expect(esServicioDelAvion({ id: 'x', helice_id: 'h' })).toBe(false);
  });
});

// ───── Hito ANCLADO: el programa no avanza solo (18-nov-2026, inv. 138) ─────

/**
 * Reporte del cliente (17-nov-2026): «ajustamos para que los servicios, en
 * vez de continuarse al siguiente de manera automática, aparezcan "vencido
 * por"… en el XA-VGV aparece vencido por 14 horas. Creo que solo se aplicó en
 * ese avión: el N4142R ya se venció por como cinco horas y aparece que faltan
 * 45 horas, cuando debería decir vencido por cinco horas».
 *
 * Los datos son la flota REAL de ese día
 * (`servicio-hito.flota-real.fixture-spec`).
 */
describe('siguienteHitoDespuesDe', () => {
  it('el primer hito ESTRICTAMENTE después: de 4,450 sigue 4,500, donde coinciden 50 y 100 (etiqueta: el mayor)', () => {
    const esperado = {
      a_las: 4500,
      intervalo: 100,
      etapas_incluidas: [50, 100],
    };
    expect(siguienteHitoDespuesDe([50, 100], 4200, 4450)).toEqual(esperado);
    expect(siguienteHitoDespuesDe([50, 100, 500, 1000], 4200, 4450)).toEqual(
      esperado,
    );
    // Y de 4,500 sigue 4,550, donde solo cae el de 50.
    expect(siguienteHitoDespuesDe([50, 100, 500, 1000], 4200, 4500)).toEqual({
      a_las: 4550,
      intervalo: 50,
      etapas_incluidas: [50],
    });
  });

  it('`desde` justo EN un hito con base decimal no se queda en el mismo hito (punto flotante)', () => {
    // XB-PEV: base 329.6, el «50 hrs» de 379.6 ⇒ sigue 429.6 (50 y 100).
    expect(siguienteHitoDespuesDe([50, 100, 200, 500], 329.6, 379.6)).toEqual({
      a_las: 429.6,
      intervalo: 100,
      etapas_incluidas: [50, 100],
    });
    // (1029.6 − 329.6) / 100 = 6.999999999999999: un `floor` a secas
    // devolvería el MISMO hito de 1,029.6 en vez de 1,129.6.
    expect((1029.6 - 329.6) / 100).toBeLessThan(7);
    expect(siguienteHitoDespuesDe([100], 329.6, 1029.6)?.a_las).toBe(1129.6);
    expect((4253.9 - 1253.9) / 500).toBeLessThan(6);
    expect(siguienteHitoDespuesDe([500], 1253.9, 4253.9)?.a_las).toBe(4753.9);
    // La base llega de Postgres como texto.
    expect(
      siguienteHitoDespuesDe([50, 100, 200, 500], '1253.9', 1353.9),
    ).toEqual({ a_las: 1403.9, intervalo: 50, etapas_incluidas: [50] });
  });

  it('media décima antes del hito YA es el hito; una décima antes, todavía no', () => {
    expect(siguienteHitoDespuesDe([50], 4200, 4499.97)?.a_las).toBe(4550);
    expect(siguienteHitoDespuesDe([50], 4200, 4500.04)?.a_las).toBe(4550);
    expect(siguienteHitoDespuesDe([50], 4200, 4499.9)?.a_las).toBe(4500);
  });

  it('`desde` por debajo de la base (o en la base) ⇒ el PRIMER hito del programa', () => {
    expect(siguienteHitoDespuesDe([100], 1500, 1200)?.a_las).toBe(1600);
    expect(siguienteHitoDespuesDe([100], 1500, 1500)?.a_las).toBe(1600);
    expect(siguienteHitoDespuesDe([100], 1500, -3000)?.a_las).toBe(1600);
    expect(siguienteHitoDespuesDe([50, 100, 200, 500], 1750, 0)).toEqual({
      a_las: 1800,
      intervalo: 50,
      etapas_incluidas: [50],
    });
  });

  it('empates: la etiqueta es el intervalo MAYOR y las etapas van ascendentes, sin importar el orden de captura', () => {
    const esperado = {
      a_las: 2250,
      intervalo: 500,
      etapas_incluidas: [50, 100, 500],
    };
    expect(siguienteHitoDespuesDe([50, 100, 200, 500], 1750, 2212)).toEqual(
      esperado,
    );
    expect(siguienteHitoDespuesDe([500, 200, 100, 50], 1750, 2212)).toEqual(
      esperado,
    );
    expect(siguienteHitoDespuesDe([100, 500, 50, 200], 1750, 2212)).toEqual(
      esperado,
    );
  });

  it('sin programa (o basura) ⇒ null; los intervalos repetidos no se duplican', () => {
    expect(siguienteHitoDespuesDe([], 0, 100)).toBeNull();
    expect(siguienteHitoDespuesDe([0, -50, 'x'], 0, 100)).toBeNull();
    expect(siguienteHitoDespuesDe([50], 0, Number.NaN)).toBeNull();
    expect(siguienteHitoDespuesDe([50, 50, '50'], 1750, 1760)).toEqual({
      a_las: 1800,
      intervalo: 50,
      etapas_incluidas: [50],
    });
  });
});

describe('posicionAtendida — hasta dónde deja atendido el programa un servicio hecho', () => {
  const P_VGV = [50, 100, 200, 500];
  const P_4142 = [50, 100, 500, 1000];
  const hecho = (m: Partial<MantenimientoHitoRow>): MantenimientoHitoRow => ({
    id: 'm',
    estado: 'COMPLETADO',
    fecha_realizada: '2026-10-01',
    ...m,
  });

  it('con horas programadas EN un hito del programa: la fila declara su hito aunque se haya hecho tarde (y sin etapa)', () => {
    // N4142R: «50 hrs» programado a 4,450 y hecho a 4,455.1.
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 4450, horas_aeronave: 4455.1 }),
        P_4142,
        4200,
      ),
    ).toBe(4450);
    // Aunque sea MUY tarde: el «100 HRS» de 4,300 hecho a 4,406.6.
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 4300, horas_aeronave: 4406.6 }),
        P_4142,
        4200,
      ),
    ).toBe(4300);
    // numeric de Postgres en texto.
    expect(
      posicionAtendida(hecho({ horas_programadas: '4450.0' }), P_4142, '4200'),
    ).toBe(4450);
  });

  it('con horas programadas FUERA del programa pero con etapa del programa: cuenta por su número (XA-VGV: 2,212 con etapa 50)', () => {
    expect(
      posicionAtendida(
        hecho({
          horas_programadas: 2212,
          etapa_intervalo_hr: '50.00',
          horas_aeronave: 2216.9,
        }),
        P_VGV,
        1750,
      ),
    ).toBe(2212);
  });

  it('con horas programadas fuera del programa y SIN etapa del programa ⇒ null', () => {
    // XB-PEV: «Servicio 50,100» capturado a las 300 con base 329.6.
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 300, horas_aeronave: 329.6 }),
        P_VGV,
        329.6,
      ),
    ).toBeNull();
    // N621TX: el «100» hecho EN la base (1,500): la base no es un hito (k ≥ 1).
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 1500, horas_aeronave: 1500 }),
        [100],
        1500,
      ),
    ).toBeNull();
    // Un cambio de llanta «a las 2,230».
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 2230, horas_aeronave: 2231 }),
        P_VGV,
        1750,
      ),
    ).toBeNull();
    // Una etapa de 25 h no existe en este programa.
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 2230, etapa_intervalo_hr: 25 }),
        P_VGV,
        1750,
      ),
    ).toBeNull();
  });

  it('sin horas programadas, hasta 10 h ANTES del hito de su etapa ⇒ el hito', () => {
    const manual = (horas_aeronave: number) =>
      posicionAtendida(
        hecho({ etapa_intervalo_hr: 100, horas_aeronave }),
        P_4142,
        4200,
      );
    expect(manual(4493)).toBe(4500);
    expect(manual(4490)).toBe(4500);
    // Justo en el hito y media décima arriba: sigue siendo ESE hito.
    expect(manual(4500)).toBe(4500);
    expect(manual(4500.04)).toBe(4500);
  });

  it('sin horas programadas, MÁS de 10 h antes del hito ⇒ se hizo tarde: la posición es el tacómetro', () => {
    const manual = (horas_aeronave: number) =>
      posicionAtendida(
        hecho({ etapa_intervalo_hr: 100, horas_aeronave }),
        P_4142,
        4200,
      );
    expect(manual(4485)).toBe(4485);
    expect(manual(4489.9)).toBe(4489.9);
    // El de 1,600 hecho a 1,632.7 (si no trajera horas programadas).
    expect(
      posicionAtendida(
        hecho({ etapa_intervalo_hr: 100, horas_aeronave: 1632.7 }),
        [100],
        1500,
      ),
    ).toBe(1632.7);
  });

  it('sin horas programadas y de una etapa DISTINTA a la del hito que viene ⇒ no lo adelanta: el tacómetro', () => {
    const de50 = (horas_aeronave: number) =>
      posicionAtendida(
        hecho({ etapa_intervalo_hr: 50, horas_aeronave }),
        P_4142,
        4200,
      );
    // Un «50 hrs» a 4,493 no es el servicio de 100 de las 4,500…
    expect(de50(4493)).toBe(4493);
    // …pero a 4,545 sí es el de 4,550 (ahí solo cae el de 50).
    expect(de50(4545)).toBe(4550);
  });

  it('sin horas programadas y sin etapa del programa (reparación, «50 Y 100 HRS» en texto libre) ⇒ null', () => {
    // N990GG «50 Y 100 HRS» a 5,504.8 y XA-VGV «200 HRS» a 2,162.7: sin
    // datos estructurados no se pueden atribuir a un hito.
    expect(
      posicionAtendida(hecho({ horas_aeronave: 5504.8 }), P_4142, 5500),
    ).toBeNull();
    expect(
      posicionAtendida(hecho({ horas_aeronave: 2162.7 }), P_VGV, 1750),
    ).toBeNull();
    expect(
      posicionAtendida(
        hecho({ etapa_intervalo_hr: 25, horas_aeronave: 2262 }),
        P_VGV,
        1750,
      ),
    ).toBeNull();
    // Con etapa pero sin tacómetro: no se sabe cuándo entró.
    expect(
      posicionAtendida(
        hecho({ etapa_intervalo_hr: 50, horas_aeronave: null }),
        P_VGV,
        1750,
      ),
    ).toBeNull();
  });

  it('lo que nunca cuenta: orden abierta, overhaul de componente, avión sin programa', () => {
    expect(
      posicionAtendida(
        {
          id: 'a',
          estado: 'EN_TALLER',
          horas_programadas: 2250,
          etapa_intervalo_hr: 500,
          horas_aeronave: 2264.2,
        },
        P_VGV,
        1750,
      ),
    ).toBeNull();
    expect(
      posicionAtendida(
        { id: 'b', estado: 'PROGRAMADO', horas_programadas: 2250 },
        P_VGV,
        1750,
      ),
    ).toBeNull();
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 2250, motor_id: 'motor-1' }),
        P_VGV,
        1750,
      ),
    ).toBeNull();
    expect(
      posicionAtendida(
        hecho({ horas_programadas: 2250, helice_id: 'helice-1' }),
        P_VGV,
        1750,
      ),
    ).toBeNull();
    expect(
      posicionAtendida(hecho({ horas_programadas: 2250 }), [], 1750),
    ).toBeNull();
    // Fila legada sin `estado` pero con fecha_realizada: está HECHA.
    expect(
      posicionAtendida(
        { id: 'l', fecha_realizada: '2026-01-01', horas_programadas: 2250 },
        P_VGV,
        1750,
      ),
    ).toBe(2250);
  });
});

describe('ultimoHitoAtendido / hitoAnclado — el programa no avanza solo', () => {
  const args = (
    a: AvionReal,
    extra: readonly MantenimientoHitoRow[] = [],
    horas: number = a.hobbs,
  ) => ({
    mantenimientos: [...a.mantenimientos, ...extra],
    intervalos: a.intervalos,
    base: a.base,
    horas,
  });
  const anclado = (
    a: AvionReal,
    extra: readonly MantenimientoHitoRow[] = [],
    horas: number = a.hobbs,
  ) => hitoAnclado(args(a, extra, horas));
  const ultimo = (
    a: AvionReal,
    extra: readonly MantenimientoHitoRow[] = [],
    horas: number = a.hobbs,
  ) => ultimoHitoAtendido(args(a, extra, horas));

  it.each([
    { matricula: 'N4142R', avion: N4142R, atendido: 4450 },
    { matricula: 'N621TX', avion: N621TX, atendido: 1600 },
    { matricula: 'N58BT', avion: N58BT, atendido: 1600 },
    { matricula: 'N990GG', avion: N990GG, atendido: 5600 },
    { matricula: 'XA-VGV', avion: XA_VGV, atendido: 2212 },
    { matricula: 'XB-PEV', avion: XB_PEV, atendido: 379.6 },
  ])(
    '$matricula (prod 17-nov-2026): último hito atendido $atendido ⇒ el anclado es el esperado',
    ({ avion, atendido }) => {
      expect(ultimo(avion)).toBe(atendido);
      expect(anclado(avion)).toEqual({
        a_las: avion.esperado.a_las,
        intervalo: avion.esperado.intervalo,
        etapas_incluidas: avion.esperado.etapas_incluidas,
      });
    },
  );

  it('N4142R: el anclado es 4,500 aunque el tacómetro ya vaya en 4,504.1 — no brinca a 4,550', () => {
    expect(anclado(N4142R)).toEqual({
      a_las: 4500,
      intervalo: 100,
      etapas_incluidas: [50, 100],
    });
    // Y tampoco brinca 200 h después: se queda hasta que alguien lo haga.
    expect(anclado(N4142R, [], 4712)?.a_las).toBe(4500);
  });

  it('N621TX: el de 1,600 se hizo tarde (1,632.7) pero DECLARA su hito ⇒ el anclado es 1,700, no 1,800', () => {
    expect(anclado(N621TX)).toEqual({
      a_las: 1700,
      intervalo: 100,
      etapas_incluidas: [100],
    });
  });

  it('XB-ANU: sin ningún servicio hecho NO hay ancla (sigue el programa cíclico; no se inventa un vencido)', () => {
    expect(ultimo(XB_ANU)).toBeNull();
    expect(anclado(XB_ANU)).toBeNull();
  });

  it('servicios hechos que NO son del programa tampoco anclan (solo reparaciones y capturas sin etapa)', () => {
    // XB-PEV sin su «50 hrs» automático: queda la ventana y el «Servicio
    // 50,100» capturado a las 300 (fuera del programa, sin etapa).
    const soloLibres = {
      ...XB_PEV,
      mantenimientos: XB_PEV.mantenimientos.slice(0, 2),
    };
    expect(anclado(soloLibres)).toBeNull();
  });

  it.each(FLOTA_REAL_17_NOV)(
    '$matricula: el dedupe del programa automático ve (o no) la orden del hito esperado',
    (avion) => {
      expect(hitoYaTieneOrden(avion.mantenimientos, avion.esperado)).toBe(
        avion.esperado.ya_tiene_orden,
      );
      expect(
        ordenAbiertaDelHito(avion.mantenimientos, avion.esperado)?.id ?? null,
      ).toBe(avion.esperado.orden);
    },
  );

  it('N4142R y N621TX: el hito vencido NO está cubierto ⇒ su orden se crea (antes el servicio tardío del ciclo anterior lo «cubría»)', () => {
    expect(
      hitoYaTieneOrden(N4142R.mantenimientos, { a_las: 4500, intervalo: 100 }),
    ).toBe(false);
    expect(
      mantenimientoQueCubreHito(N621TX.mantenimientos, {
        a_las: 1700,
        intervalo: 100,
      }),
    ).toBeNull();
  });

  it('al completar la orden del hito el programa avanza UN hito: N4142R 4,500 ⇒ 4,550; N621TX 1,700 ⇒ 1,800', () => {
    const orden4500: MantenimientoHitoRow = {
      id: 'orden-4500',
      estado: 'COMPLETADO',
      horas_programadas: 4500,
      etapa_intervalo_hr: 100,
      horas_aeronave: 4504.1,
      fecha_realizada: '2026-11-18',
    };
    expect(anclado(N4142R, [orden4500])).toEqual({
      a_las: 4550,
      intervalo: 50,
      etapas_incluidas: [50],
    });
    // Mientras siga ABIERTA no avanza (y la sostiene `hitoPendienteDeOrden`).
    const abierta: MantenimientoHitoRow = {
      ...orden4500,
      estado: 'PROGRAMADO',
      horas_aeronave: null,
      fecha_realizada: null,
    };
    expect(anclado(N4142R, [abierta])?.a_las).toBe(4500);
    expect(hitoPendienteDeOrden(args(N4142R, [abierta]))).toMatchObject({
      a_las: 4500,
      intervalo: 100,
      etapas_incluidas: [50, 100],
    });

    const orden1700: MantenimientoHitoRow = {
      id: 'orden-1700',
      estado: 'COMPLETADO',
      horas_programadas: 1700,
      etapa_intervalo_hr: 100,
      horas_aeronave: 1702.4,
      fecha_realizada: '2026-11-18',
    };
    expect(anclado(N621TX, [orden1700])).toEqual({
      a_las: 1800,
      intervalo: 100,
      etapas_incluidas: [100],
    });
  });

  it('servicio manual SIN horas programadas: hecho 7 h antes cuenta para ESE hito; 15 h antes, no', () => {
    const manual = (horas_aeronave: number): MantenimientoHitoRow => ({
      id: 'manual',
      estado: 'COMPLETADO',
      etapa_intervalo_hr: 100,
      horas_aeronave,
      fecha_realizada: '2026-11-10',
    });
    const hito4500 = { a_las: 4500, intervalo: 100 };
    // A 4,493 h (7 h antes): el de 4,500 queda atendido ⇒ sigue 4,550, y el
    // dedupe NO re-crea lo que el mecánico acaba de terminar.
    expect(anclado(N4142R, [manual(4493)], 4495)).toEqual({
      a_las: 4550,
      intervalo: 50,
      etapas_incluidas: [50],
    });
    expect(
      hitoYaTieneOrden([...N4142R.mantenimientos, manual(4493)], hito4500),
    ).toBe(true);
    // A 4,485 h (15 h antes): queda fuera de la ventana ⇒ el de 4,500 sigue
    // pendiente y SIN cubrir (su orden se crea).
    expect(anclado(N4142R, [manual(4485)], 4495)).toEqual({
      a_las: 4500,
      intervalo: 100,
      etapas_incluidas: [50, 100],
    });
    expect(
      hitoYaTieneOrden([...N4142R.mantenimientos, manual(4485)], hito4500),
    ).toBe(false);
  });

  it('servicio manual SIN horas programadas hecho TARDE (después del hito): atiende ese hito y sigue el que viene', () => {
    // El de 1,700 del N621TX capturado a mano a 1,706 h, sin número.
    const tardio: MantenimientoHitoRow = {
      id: 'manual-tarde',
      estado: 'COMPLETADO',
      etapa_intervalo_hr: 100,
      horas_aeronave: 1706,
      fecha_realizada: '2026-11-19',
    };
    expect(ultimo(N621TX, [tardio], 1706)).toBe(1706);
    expect(anclado(N621TX, [tardio], 1706)?.a_las).toBe(1800);
  });

  it('una reparación COMPLETADA después del hito (sin etapa del programa) NO lo atiende', () => {
    const reparacion: MantenimientoHitoRow = {
      id: 'llanta',
      estado: 'COMPLETADO',
      horas_aeronave: 4503,
      fecha_realizada: '2026-11-16',
    };
    expect(anclado(N4142R, [reparacion])).toMatchObject({
      a_las: 4500,
      intervalo: 100,
    });
    expect(
      hitoYaTieneOrden([...N4142R.mantenimientos, reparacion], {
        a_las: 4500,
        intervalo: 100,
      }),
    ).toBe(false);
    // Tampoco con horas programadas fuera del programa («a las 4,503»).
    expect(
      anclado(N4142R, [{ ...reparacion, horas_programadas: 4503 }])?.a_las,
    ).toBe(4500);
    // Ni el overhaul de un motor programado justo en el hito.
    expect(
      anclado(N4142R, [
        { ...reparacion, horas_programadas: 4500, motor_id: 'motor-1' },
      ])?.a_las,
    ).toBe(4500);
  });

  it('guarda de futuro: un «hecho» de un hito a cientos de horas adelante no esconde los servicios que tocan', () => {
    // Dedazo: alguien cerró a 4,504 h una orden de 5,400 (o tecleó 5450 en
    // vez de 4450).
    const dedazo: MantenimientoHitoRow = {
      id: 'dedazo',
      estado: 'COMPLETADO',
      horas_programadas: 5400,
      etapa_intervalo_hr: 100,
      horas_aeronave: 4504,
      fecha_realizada: '2026-11-17',
    };
    expect(ultimo(N4142R, [dedazo])).toBe(4450);
    expect(anclado(N4142R, [dedazo])?.a_las).toBe(4500);
    // El tope es tacómetro + intervalo más chico (4,504.1 + 50 = 4,554.1):
    // 4,550 todavía es creíble; 4,600 ya no.
    expect(ultimo(N4142R, [{ ...dedazo, horas_programadas: 4550 }])).toBe(4550);
    expect(ultimo(N4142R, [{ ...dedazo, horas_programadas: 4600 }])).toBe(4450);
    // Lo mismo con el tacómetro mal capturado en un servicio sin número
    // (45,060 en vez de 4,506).
    expect(
      ultimo(N4142R, [
        {
          id: 'taco-mal',
          estado: 'COMPLETADO',
          etapa_intervalo_hr: 100,
          horas_aeronave: 45060,
          fecha_realizada: '2026-11-17',
        },
      ]),
    ).toBe(4450);
  });

  it('el hito anclado JAMÁS queda cubierto por un servicio hecho sin número (si no, nadie crearía su orden)', () => {
    // Barrido: un servicio manual de 50 o de 100, sin horas programadas,
    // hecho a cualquier tacómetro entre 4,440 y 4,560. Lo que el dedupe da
    // por cubierto (regla 2) tiene que ser lo MISMO que el ancla da por
    // atendido: el anclado nunca puede salir «cubierto» por esa fila.
    const cubiertos: string[] = [];
    for (const etapa of [50, 100]) {
      for (let decimas = 44400; decimas <= 45600; decimas += 1) {
        const ha = decimas / 10;
        const manual: MantenimientoHitoRow = {
          id: 'manual',
          estado: 'COMPLETADO',
          etapa_intervalo_hr: etapa,
          horas_aeronave: ha,
          fecha_realizada: '2026-11-10',
        };
        const hito = anclado(N4142R, [manual], Math.max(ha, N4142R.hobbs));
        if (!hito || mantenimientoCubreHito(manual, hito)) {
          cubiertos.push(`etapa ${etapa} a ${ha} h ⇒ ${hito?.a_las ?? 'nada'}`);
        }
      }
    }
    expect(cubiertos).toEqual([]);
  });

  it('sin programa o sin tacómetro no se afirma nada', () => {
    expect(
      hitoAnclado({
        mantenimientos: N4142R.mantenimientos,
        intervalos: [],
        base: 4200,
        horas: 4504.1,
      }),
    ).toBeNull();
    expect(anclado(N4142R, [], Number.NaN)).toBeNull();
    // Sin tacómetro capturado (0 h) todo lo hecho queda por arriba del tope:
    // no hay ancla y la ficha cae al primer hito del programa, como siempre.
    expect(anclado(N4142R, [], 0)).toBeNull();
  });
});
