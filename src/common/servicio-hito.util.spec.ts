import {
  MANT_HITO_COLS,
  NOTA_SERVICIO_AUTOMATICO,
  esServicioDelAvion,
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
  servicioHecho,
  type MantenimientoHitoRow,
} from './servicio-hito.util';

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

  it('servicio de la MISMA etapa ya HECHO dentro del ciclo cubre el hito', () => {
    // Entró a 2,210 h: dentro de (2250 − 50, 2250] ⇒ el hito está cubierto.
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
    ).toBe(true);
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

  it('regla 2 sin tope: misma etapa hecha antes O DESPUÉS del hito, dentro del ciclo', () => {
    const hecho = (horas_aeronave: number): MantenimientoHitoRow => ({
      id: `h-${horas_aeronave}`,
      estado: 'COMPLETADO',
      etapa_intervalo_hr: 50,
      horas_aeronave,
      fecha_realizada: '2026-10-01',
    });
    expect(hitoAtendido([hecho(2216.9)], hito)).toBe(true);
    expect(hitoAtendido([hecho(2262)], hito)).toBe(true);
    // Antes del ciclo (≤ 2,200): es de otro hito.
    expect(hitoAtendido([hecho(2200)], hito)).toBe(false);
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
