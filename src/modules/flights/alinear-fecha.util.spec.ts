import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { fechaHoraCancun } from '../../common/fecha-cancun.util';
import {
  CODE_SIN_FECHA,
  CODE_TRAMOS_NO_MOVIDOS,
  CODE_VUELO_CANCELADO,
  CODE_VUELO_YA_VOLO,
  MENSAJE_SIN_FECHA,
  MENSAJE_VUELO_CANCELADO,
  MENSAJE_VUELO_YA_VOLO,
  avisoReagendaVuelo,
  errorSinFecha,
  errorTramosNoMovidos,
  errorVueloCancelado,
  errorVueloYaVolo,
  mensajeTramosNoMovidos,
  planAlinearFecha,
  respuestaAlinearFecha,
  type TramoAlinearInput,
} from './alinear-fecha.util';

const V = 'aaaaaaaa-0000-4000-8000-000000000338';

const tramo = (
  id: string,
  orden: number,
  fecha: string | null,
  extra: Partial<TramoAlinearInput> = {},
): TramoAlinearInput => ({
  id,
  orden,
  origen_iata: 'CUN',
  destino_iata: 'CZM',
  fecha_salida_plan: fecha,
  ...extra,
});

describe('textos de la alineación (es-MX, fuente única)', () => {
  it('mensajes fijos', () => {
    expect(MENSAJE_VUELO_YA_VOLO).toBe(
      'La operación ya empezó: la fecha de cada tramo se edita desde el vuelo.',
    );
    expect(MENSAJE_VUELO_CANCELADO).toBe(
      'El vuelo está cancelado: no hay operación que mover.',
    );
    expect(MENSAJE_SIN_FECHA).toBe(
      'El vuelo no tiene fecha: captúrala en la cotización o en el detalle del vuelo antes de mover los tramos.',
    );
  });

  it('falla a medio camino: dice si se regresó todo o quedó algo a medias', () => {
    expect(mensajeTramosNoMovidos(true)).toBe(
      'No se pudo mover el vuelo operativo (falló el guardado a medio camino) y no se cambió nada. Intenta de nuevo o mueve la fecha desde el detalle del vuelo.',
    );
    expect(mensajeTramosNoMovidos(false)).toBe(
      'No se pudo mover todo el vuelo operativo: algunos tramos quedaron con la fecha nueva y otros no. Revisa las fechas de los tramos en el detalle del vuelo.',
    );
  });

  it('errores estructurados: status, code (error) y details', () => {
    const yaVolo = errorVueloYaVolo(V, 338);
    expect(yaVolo).toBeInstanceOf(ConflictException);
    expect(yaVolo.getResponse()).toEqual({
      message: MENSAJE_VUELO_YA_VOLO,
      error: CODE_VUELO_YA_VOLO,
      details: { vuelo_id: V, folio: 338 },
    });
    const cancelado = errorVueloCancelado(V, undefined);
    expect(cancelado).toBeInstanceOf(ConflictException);
    expect(cancelado.getResponse()).toEqual({
      message: MENSAJE_VUELO_CANCELADO,
      error: CODE_VUELO_CANCELADO,
      details: { vuelo_id: V, folio: null },
    });
    const sinFecha = errorSinFecha(V);
    expect(sinFecha).toBeInstanceOf(BadRequestException);
    expect(sinFecha.getResponse()).toEqual({
      message: MENSAJE_SIN_FECHA,
      error: CODE_SIN_FECHA,
      details: { vuelo_id: V },
    });
    const noMovidos = errorTramosNoMovidos(V, true, 'timeout');
    expect(noMovidos).toBeInstanceOf(ServiceUnavailableException);
    expect(noMovidos.getResponse()).toEqual({
      message: mensajeTramosNoMovidos(true),
      error: CODE_TRAMOS_NO_MOVIDOS,
      details: { vuelo_id: V, revertido: true, tecnico: 'timeout' },
    });
  });

  it('aviso de reagenda: el MISMO texto que mandaba «Editar datos» del vuelo', () => {
    const salida = '13/10/26, 9:00 a.m.';
    const regreso = '15/10/26, 4:00 p.m.';
    // Plantilla literal de `flights.update` antes del helper.
    const legado = (partes: string[]) => ({
      titulo: `Vuelo #338 reagendado`,
      cuerpo: `CUN → CZM ${partes.join(' y ')} (hora Cancún).`,
    });
    const base = { folio: 338, origen: 'CUN', destino: 'CZM' };
    expect(avisoReagendaVuelo({ ...base, salida })).toEqual(
      legado([`ahora sale ${salida}`]),
    );
    expect(avisoReagendaVuelo({ ...base, regreso })).toEqual(
      legado([`el REGRESO ahora sale ${regreso}`]),
    );
    expect(avisoReagendaVuelo({ ...base, salida, regreso })).toEqual(
      legado([`ahora sale ${salida}`, `el REGRESO ahora sale ${regreso}`]),
    );
    expect(avisoReagendaVuelo({ ...base, salida, regreso: null }).cuerpo).toBe(
      `CUN → CZM ahora sale ${salida} (hora Cancún).`,
    );
  });
});

describe('planAlinearFecha', () => {
  it('delta positivo: cada tramo conserva su hora de pared en Cancún', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-13T14:00:00.000Z',
      tramos: [
        tramo('t1', 1, '2026-10-10T14:00:00+00:00'),
        tramo('t2', 2, '2026-10-10T22:30:00+00:00'),
      ],
    });
    expect(plan.dia_objetivo).toBe('2026-10-13');
    expect(plan.dia_referencia).toBe('2026-10-10');
    expect(plan.delta_dias).toBe(3);
    expect(plan.mover).toEqual(['t1', 't2']);
    expect(
      plan.tramos.map((t) => fechaHoraCancun(t.fecha_salida_plan)),
    ).toEqual(['2026-10-13 09:00', '2026-10-13 17:30']);
    expect(plan.tramos[0].fecha_salida_plan_antes).toBe(
      '2026-10-10T14:00:00+00:00',
    );
  });

  it('delta negativo', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-08T15:00:00.000Z',
      tramos: [tramo('t1', 1, '2026-10-10T14:00:00.000Z')],
    });
    expect(plan.delta_dias).toBe(-2);
    expect(plan.tramos[0].fecha_salida_plan).toBe('2026-10-08T14:00:00.000Z');
  });

  it('el DÍA es el de Cancún, no el UTC (22:00 Cancún ya es mañana en UTC)', () => {
    // 10-oct 22:00 Cancún = 11-oct 03:00 UTC; objetivo 13-oct ⇒ +3, no +2.
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-13T15:00:00.000Z',
      tramos: [
        tramo('t1', 1, '2026-10-11T03:00:00.000Z'),
        tramo('t2', 2, '2026-10-11T04:30:00.000Z'),
      ],
    });
    expect(plan.dia_referencia).toBe('2026-10-10');
    expect(plan.delta_dias).toBe(3);
    expect(
      plan.tramos.map((t) => fechaHoraCancun(t.fecha_salida_plan)),
    ).toEqual(['2026-10-13 22:00', '2026-10-13 23:30']);
  });

  it('delta 0 (mismo día, otra hora): no se mueve nada', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-10T20:00:00.000Z',
      tramos: [tramo('t1', 1, '2026-10-10T14:00:00.000Z')],
      fechaTrasladoFinal: '2026-10-10T23:00:00.000Z',
    });
    expect(plan.delta_dias).toBe(0);
    expect(plan.mover).toEqual([]);
    expect(plan.tramos[0].fecha_salida_plan).toBe('2026-10-10T14:00:00.000Z');
    expect(plan.mover_traslado_final).toBe(false);
  });

  it('tramo sin fecha se queda sin fecha (hereda del anterior)', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-12T14:00:00.000Z',
      tramos: [
        tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
        tramo('t2', 2, null),
      ],
    });
    expect(plan.mover).toEqual(['t1']);
    expect(plan.tramos[1].fecha_salida_plan).toBeNull();
  });

  it('sin ningún tramo con fecha: el primero recibe el objetivo tal cual y delta null', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-12T16:15:00+00:00',
      tramos: [tramo('t2', 2, null), tramo('t1', 1, null)],
    });
    expect(plan.delta_dias).toBeNull();
    expect(plan.dia_referencia).toBeNull();
    expect(plan.mover).toEqual(['t1']);
    expect(plan.tramos.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(plan.tramos[0].fecha_salida_plan).toBe('2026-10-12T16:15:00.000Z');
    expect(plan.tramos[1].fecha_salida_plan).toBeNull();
  });

  it('sin tramos vivos: nada que mover', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-12T16:15:00.000Z',
      tramos: [],
    });
    expect(plan.delta_dias).toBeNull();
    expect(plan.mover).toEqual([]);
    expect(plan.tramos).toEqual([]);
  });

  it('los cancelados no cuentan (ni como referencia ni para mover) y se ordena por orden', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-14T14:00:00.000Z',
      tramos: [
        tramo('t2', 2, '2026-10-12T20:00:00.000Z'),
        tramo('t1', 1, '2026-10-09T14:00:00.000Z', {
          cancelada_at: '2026-10-01T00:00:00Z',
        }),
        tramo('t3', 3, '2026-10-12T23:00:00.000Z'),
      ],
    });
    expect(plan.tramos.map((t) => t.id)).toEqual(['t2', 't3']);
    expect(plan.dia_referencia).toBe('2026-10-12');
    expect(plan.delta_dias).toBe(2);
    expect(plan.mover).toEqual(['t2', 't3']);
  });

  it('multi-día: el regreso alineado con el último tramo se mueve los mismos días', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-15T14:00:00.000Z',
      tramos: [
        tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
        tramo('t2', 2, '2026-10-12T21:00:00.000Z'),
      ],
      fechaTrasladoFinal: '2026-10-12T21:00:00+00:00',
    });
    expect(plan.delta_dias).toBe(5);
    expect(plan.mover_traslado_final).toBe(true);
    expect(plan.fecha_traslado_final).toBe('2026-10-17T21:00:00.000Z');
    expect(fechaHoraCancun(plan.tramos[1].fecha_salida_plan)).toBe(
      '2026-10-17 16:00',
    );
  });

  it('multi-día: si la cotización YA movió el regreso, no se mueve otra vez', () => {
    // La oficina cambió salida (10 → 15) Y regreso (12 → 17) en la
    // cotización: `revise` ya escribió el regreso nuevo. Moverlo +5 lo
    // desplazaría dos veces (22-oct).
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-15T14:00:00.000Z',
      tramos: [
        tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
        tramo('t2', 2, '2026-10-12T21:00:00.000Z'),
      ],
      fechaTrasladoFinal: '2026-10-17T21:00:00.000Z',
    });
    expect(plan.mover_traslado_final).toBe(false);
    expect(plan.fecha_traslado_final).toBe('2026-10-17T21:00:00.000Z');
    expect(fechaHoraCancun(plan.tramos[1].fecha_salida_plan)).toBe(
      '2026-10-17 16:00',
    );
  });

  it('sin regreso capturado: null y nada que mover', () => {
    const plan = planAlinearFecha({
      fechaObjetivo: '2026-10-15T14:00:00.000Z',
      tramos: [tramo('t1', 1, '2026-10-10T14:00:00.000Z')],
      fechaTrasladoFinal: null,
    });
    expect(plan.fecha_traslado_final_antes).toBeNull();
    expect(plan.fecha_traslado_final).toBeNull();
    expect(plan.mover_traslado_final).toBe(false);
  });

  it('acepta Date como objetivo y rechaza una fecha inválida', () => {
    expect(
      planAlinearFecha({
        fechaObjetivo: new Date('2026-10-11T14:00:00Z'),
        tramos: [tramo('t1', 1, '2026-10-10T14:00:00Z')],
      }).delta_dias,
    ).toBe(1);
    expect(() =>
      planAlinearFecha({ fechaObjetivo: 'no-es-fecha', tramos: [] }),
    ).toThrow(/Fecha inválida/);
  });
});

describe('respuestaAlinearFecha', () => {
  const plan = planAlinearFecha({
    fechaObjetivo: '2026-10-15T14:00:00.000Z',
    tramos: [
      tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
      tramo('t2', 2, '2026-10-12T21:00:00.000Z'),
    ],
    fechaTrasladoFinal: '2026-10-12T21:00:00.000Z',
  });

  it('solo cuenta lo que se escribió; lo no escrito conserva su fecha', () => {
    const r = respuestaAlinearFecha({
      vueloId: V,
      folio: 338,
      plan,
      movidos: new Set(['t1']),
      regresoMovido: false,
    });
    expect(r).toEqual({
      vuelo_id: V,
      folio: 338,
      delta_dias: 5,
      fecha_objetivo: '2026-10-15T14:00:00.000Z',
      tramos: [
        {
          id: 't1',
          orden: 1,
          origen_iata: 'CUN',
          destino_iata: 'CZM',
          fecha_salida_plan_antes: '2026-10-10T14:00:00.000Z',
          fecha_salida_plan: '2026-10-15T14:00:00.000Z',
          movido: true,
        },
        {
          id: 't2',
          orden: 2,
          origen_iata: 'CUN',
          destino_iata: 'CZM',
          fecha_salida_plan_antes: '2026-10-12T21:00:00.000Z',
          fecha_salida_plan: '2026-10-12T21:00:00.000Z',
          movido: false,
        },
      ],
      fecha_traslado_final: '2026-10-12T21:00:00.000Z',
      tramos_movidos: 1,
      fecha_traslado_final_antes: '2026-10-12T21:00:00.000Z',
      fecha_traslado_final_movida: false,
    });
  });

  it('regreso movido y folio ausente', () => {
    const r = respuestaAlinearFecha({
      vueloId: V,
      folio: null,
      plan,
      movidos: new Set(['t1', 't2']),
      regresoMovido: true,
    });
    expect(r.folio).toBeNull();
    expect(r.tramos_movidos).toBe(2);
    expect(r.fecha_traslado_final).toBe('2026-10-17T21:00:00.000Z');
    expect(r.fecha_traslado_final_movida).toBe(true);
  });
});
