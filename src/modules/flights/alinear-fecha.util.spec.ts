import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { fechaHoraCancun } from '../../common/fecha-cancun.util';
import {
  CODE_OPERACION_CAMBIO,
  CODE_SIN_FECHA,
  CODE_TRAMOS_NO_MOVIDOS,
  CODE_VUELO_CANCELADO,
  CODE_VUELO_YA_VOLO,
  MAX_TRAMOS_EN_AVISO,
  MENSAJE_FECHA_VUELO_SIN_ZONA,
  MENSAJE_OPERACION_CAMBIO,
  MENSAJE_SIN_FECHA,
  MENSAJE_VUELO_CANCELADO,
  MENSAJE_VUELO_YA_VOLO,
  RE_INSTANTE_ISO_CON_ZONA,
  avisoOperacionMovida,
  avisoReagendaVuelo,
  errorOperacionCambio,
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
    expect(MENSAJE_OPERACION_CAMBIO).toBe(
      'El vuelo operativo cambió mientras guardabas y no se movió nada. Recarga y vuelve a intentarlo, o mueve la fecha desde el detalle del vuelo.',
    );
    expect(MENSAJE_FECHA_VUELO_SIN_ZONA).toBe(
      'fecha_vuelo debe ser un instante ISO 8601 con hora y zona (Z u offset), p. ej. 2026-10-13T14:00:00.000Z.',
    );
  });

  it('fecha_vuelo del cuerpo: solo instantes completos con zona', () => {
    for (const ok of [
      '2026-10-13T14:00:00.000Z',
      '2026-10-13T14:00:00Z',
      '2026-10-13T14:00Z',
      '2026-10-13T09:00:00-05:00',
      '2026-10-13T09:00:00+0000',
      '2026-10-13T14:00:00+00',
      '2026-10-13T14:00:00.123456+00:00',
    ]) {
      expect(RE_INSTANTE_ISO_CON_ZONA.test(ok)).toBe(true);
    }
    for (const mal of [
      '2026-10-13',
      '2026-10-13T02:00',
      '2026-10-13T02:00:00',
      '2026-10-13 14:00:00Z',
      '13/10/2026',
    ]) {
      expect(RE_INSTANTE_ISO_CON_ZONA.test(mal)).toBe(false);
    }
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
    const cambio = errorOperacionCambio(V, 338);
    expect(cambio).toBeInstanceOf(ConflictException);
    expect(cambio.getResponse()).toEqual({
      message: MENSAJE_OPERACION_CAMBIO,
      error: CODE_OPERACION_CAMBIO,
      details: { vuelo_id: V, folio: 338 },
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

  it('aviso de la alineación: PROPIO (no el «reagendado» de revise) y con cada tramo movido', () => {
    const t = (o: string, d: string, f: string | null) => ({
      origen_iata: o,
      destino_iata: d,
      fecha_salida_plan: f,
    });
    expect(
      avisoOperacionMovida({
        folio: 338,
        tramos: [
          t('CUN', 'HOL', '2026-10-15T13:00:00.000Z'),
          t('HOL', 'CUN', '2026-10-17T21:00:00.000Z'),
        ],
      }),
    ).toEqual({
      titulo: 'Vuelo #338: la operación cambió de día',
      cuerpo:
        'Tramos movidos (hora Cancún): CUN → HOL jue 15 oct 08:00 · HOL → CUN sáb 17 oct 16:00.',
    });
    expect(avisoOperacionMovida({ folio: 338, tramos: [] }).titulo).not.toMatch(
      /reagendado/,
    );
    // Hasta MAX_TRAMOS_EN_AVISO se nombran todos; con más, 3 y «y N más».
    const muchos = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        t('CUN', `T${i + 1}`, '2026-10-15T13:00:00.000Z'),
      );
    expect(MAX_TRAMOS_EN_AVISO).toBe(4);
    expect(
      avisoOperacionMovida({ folio: 1, tramos: muchos(4) }).cuerpo,
    ).toMatch(/CUN → T4 jue 15 oct 08:00\.$/u);
    const seis = avisoOperacionMovida({ folio: 1, tramos: muchos(6) }).cuerpo;
    expect(seis).toMatch(/CUN → T3 jue 15 oct 08:00 · y 3 más\.$/u);
    expect(seis).not.toMatch(/T4/);
    // Sin fecha legible: lo dice, nunca «Invalid Date».
    expect(
      avisoOperacionMovida({ folio: 1, tramos: [t('CUN', 'CZM', null)] })
        .cuerpo,
    ).toBe('Tramos movidos (hora Cancún): CUN → CZM sin fecha.');
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

  describe('lo que la cotización ACABA de escribir no se vuelve a mover (revisión 5-oct)', () => {
    const horas = (plan: ReturnType<typeof planAlinearFecha>) =>
      plan.tramos.map((t) => fechaHoraCancun(t.fecha_salida_plan));

    it('tramo final SIN fecha + regreso capturado en el mismo guardado (repro de la revisión)', () => {
      // Antes: tramo 1 el 10-oct 09:00, tramo 2 sin fecha, sin regreso. La
      // oficina guarda salida 15-oct 09:00 y regreso 17-oct 16:00: revise
      // escribe fecha_vuelo=15, fecha_traslado_final=17 y LLENA el tramo 2
      // con el regreso (`fechas.fin`). Antes del arreglo: t2 y regreso al 22.
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-15T14:00:00+00:00',
        tramos: [
          tramo('t1', 1, '2026-10-10T14:00:00+00:00'),
          tramo('t2', 2, '2026-10-17T21:00:00+00:00'),
        ],
        fechaTrasladoFinal: '2026-10-17T21:00:00+00:00',
      });
      expect(plan.delta_dias).toBe(5);
      expect(plan.mover).toEqual(['t1']);
      expect(horas(plan)).toEqual(['2026-10-15 09:00', '2026-10-17 16:00']);
      expect(plan.tramos[1].se_conserva).toBe('dia_del_regreso');
      expect(plan.tramos[0].se_conserva).toBeNull();
      expect(plan.mover_traslado_final).toBe(false);
      expect(plan.fecha_traslado_final).toBe('2026-10-17T21:00:00+00:00');
      expect(plan.ancla_id).toBe('t1');
    });

    it('la oficina movió salida Y regreso: los tramos siguen al regreso nuevo y el regreso no se toca', () => {
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-15T14:00:00.000Z',
        tramos: [
          tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
          tramo('t2', 2, '2026-10-11T15:00:00.000Z'),
          tramo('t3', 3, '2026-10-12T21:00:00.000Z'),
        ],
        fechaTrasladoFinal: '2026-10-17T21:00:00.000Z',
      });
      expect(plan.mover).toEqual(['t1', 't2', 't3']);
      expect(horas(plan)).toEqual([
        '2026-10-15 09:00',
        '2026-10-16 10:00',
        '2026-10-17 16:00',
      ]);
      expect(plan.mover_traslado_final).toBe(false);
    });

    it('cambio de días hacia ATRÁS con el regreso nuevo capturado: el tramo llenado se queda', () => {
      // t2 vacío; la oficina guarda salida 8-oct y regreso 9-oct 16:00.
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-08T14:00:00.000Z',
        tramos: [
          tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
          tramo('t2', 2, '2026-10-09T21:00:00.000Z'),
        ],
        fechaTrasladoFinal: '2026-10-09T21:00:00.000Z',
      });
      expect(plan.delta_dias).toBe(-2);
      expect(horas(plan)).toEqual(['2026-10-08 09:00', '2026-10-09 16:00']);
      expect(plan.mover_traslado_final).toBe(false);
    });

    it('viaje de UN día hacia atrás: se mueve completo, regreso incluido', () => {
      // 71 de 79 vuelos con regreso lo tienen el mismo día de la salida.
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-09T14:00:00.000Z',
        tramos: [
          tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
          tramo('t2', 2, '2026-10-10T21:00:00.000Z'),
        ],
        fechaTrasladoFinal: '2026-10-10T21:00:00.000Z',
      });
      expect(plan.delta_dias).toBe(-1);
      expect(horas(plan)).toEqual(['2026-10-09 09:00', '2026-10-09 16:00']);
      expect(plan.mover_traslado_final).toBe(true);
      expect(fechaHoraCancun(plan.fecha_traslado_final)).toBe(
        '2026-10-09 16:00',
      );
    });

    it('viaje de un día hacia atrás con el regreso YA movido por la oficina: el regreso no se toca', () => {
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-09T14:00:00.000Z',
        tramos: [
          tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
          tramo('t2', 2, '2026-10-10T21:00:00.000Z'),
        ],
        fechaTrasladoFinal: '2026-10-09T21:00:00.000Z',
      });
      expect(horas(plan)).toEqual(['2026-10-09 09:00', '2026-10-09 16:00']);
      expect(plan.mover_traslado_final).toBe(false);
    });

    it('viaje de varios días acortado (el regreso de la cotización sigue después de la salida nueva): manda el regreso', () => {
      // 10 → 12 en la operación; la cotización ahora dice 11 → 12.
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-11T14:00:00.000Z',
        tramos: [
          tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
          tramo('t2', 2, '2026-10-12T15:00:00.000Z'),
          tramo('t3', 3, '2026-10-12T21:00:00.000Z'),
        ],
        fechaTrasladoFinal: '2026-10-12T21:00:00.000Z',
      });
      // Sin el arreglo t2 quedaba el 13 DESPUÉS de t3 (12), y el regreso
      // de la cotización se reescribía al 13.
      expect(horas(plan)).toEqual([
        '2026-10-11 09:00',
        '2026-10-12 10:00',
        '2026-10-12 16:00',
      ]);
      expect(plan.tramos.map((t) => t.se_conserva)).toEqual([
        null,
        'dia_del_regreso',
        'dia_del_regreso',
      ]);
      expect(plan.mover_traslado_final).toBe(false);
    });

    it('tramo 1 SIN fecha que revise llenó con la salida nueva: no es referencia; se recorre el resto', () => {
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-15T14:00:00+00:00',
        tramos: [
          tramo('t1', 1, '2026-10-15T14:00:00+00:00'),
          tramo('t2', 2, '2026-10-12T21:00:00+00:00'),
          tramo('t3', 3, '2026-10-13T21:00:00+00:00'),
        ],
      });
      expect(plan.dia_referencia).toBe('2026-10-12');
      expect(plan.delta_dias).toBe(3);
      expect(plan.ancla_id).toBe('t2');
      expect(plan.mover).toEqual(['t2', 't3']);
      expect(plan.tramos[0].se_conserva).toBe('ya_en_la_fecha');
      expect(horas(plan)).toEqual([
        '2026-10-15 09:00',
        '2026-10-15 16:00',
        '2026-10-16 16:00',
      ]);
    });

    it('control: tramo 1 ya alineado y el resto DESPUÉS ⇒ delta 0, nada se mueve', () => {
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-15T14:00:00+00:00',
        tramos: [
          tramo('t1', 1, '2026-10-15T14:00:00+00:00'),
          tramo('t2', 2, '2026-10-17T21:00:00+00:00'),
        ],
      });
      expect(plan.delta_dias).toBe(0);
      expect(plan.mover).toEqual([]);
      expect(plan.tramos.map((t) => t.se_conserva)).toEqual([null, null]);
    });

    it('regreso incoherente de antes (anterior a la salida nueva) con delta negativo: no se toca y no frena tramos', () => {
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-08T14:00:00.000Z',
        tramos: [
          tramo('t1', 1, '2026-10-10T14:00:00.000Z'),
          tramo('t2', 2, '2026-10-11T21:00:00.000Z'),
        ],
        fechaTrasladoFinal: '2026-10-05T21:00:00.000Z',
      });
      expect(plan.mover).toEqual(['t1', 't2']);
      expect(plan.mover_traslado_final).toBe(false);
    });

    it('sin referencia, el ancla es el primer tramo vivo', () => {
      const plan = planAlinearFecha({
        fechaObjetivo: '2026-10-12T16:15:00.000Z',
        tramos: [tramo('t2', 2, null), tramo('t1', 1, null)],
      });
      expect(plan.ancla_id).toBe('t1');
      expect(
        planAlinearFecha({
          fechaObjetivo: '2026-10-12T16:15:00.000Z',
          tramos: [],
        }).ancla_id,
      ).toBeNull();
    });
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
          se_conserva: null,
          movido: true,
        },
        {
          id: 't2',
          orden: 2,
          origen_iata: 'CUN',
          destino_iata: 'CZM',
          fecha_salida_plan_antes: '2026-10-12T21:00:00.000Z',
          fecha_salida_plan: '2026-10-12T21:00:00.000Z',
          se_conserva: null,
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
