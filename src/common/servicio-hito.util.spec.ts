import {
  MANT_HITO_COLS,
  NOTA_SERVICIO_AUTOMATICO,
  hitoYaTieneOrden,
  mantenimientoCubreHito,
  mantenimientoQueCubreHito,
  ordenAbiertaDelHito,
  ordenDeServicio,
  ordenEsAutomatica,
  ordenEstaAbierta,
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
    ]) {
      expect(MANT_HITO_COLS.split(', ')).toContain(col);
    }
  });
});
