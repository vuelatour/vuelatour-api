import {
  reservaOverhaulDelPeriodo,
  reservaOverhaulPeriodoUsd,
  tarifaReservaEnDia,
  tarifaReservaOverhaul,
  tarifasDeLegado,
  tarifasDeVigencias,
  type TarifaReservaVigente,
} from './reserva-overhaul.util';

/**
 * RESERVA DE OVERHAUL CON VIGENCIA — «a partir de» (10-nov-2026, API
 * 0.0.135, invariante 130). Pedido del cliente: «que pudiéramos ponerle
 * desde cuándo entra en vigor esa reserva de overhaul… que dijera ahí "a
 * partir de" y la fecha». Caso real del Excel del N4142R (septiembre 2026):
 * 41.50 h voladas, Seneca de 2 motores.
 */
const N4142R = 'aaaaaaaa-0000-4000-8000-000000004142';
const N621TX = 'aaaaaaaa-0000-4000-8000-000000000621';

describe('tarifasDeVigencias / tarifasDeLegado', () => {
  it('la tabla con vigencias: total = tarifa por motor × motores', () => {
    expect(
      tarifasDeVigencias([
        {
          aeronave_id: N4142R,
          vigente_desde: '2026-11-01',
          usd_hr_por_motor: '55.00',
          motores: 2,
        },
        {
          aeronave_id: N621TX,
          vigente_desde: '2026-01-01',
          usd_hr_por_motor: 200,
          motores: '1',
        },
      ]),
    ).toEqual([
      {
        aeronave_id: N4142R,
        vigente_desde: '2026-11-01',
        usd_por_hora: 110,
        motores: 2,
      },
      {
        aeronave_id: N621TX,
        vigente_desde: '2026-01-01',
        usd_por_hora: 200,
        motores: 1,
      },
    ]);
  });

  it('la tabla legada (sin la migración): UNA tarifa por avión «desde siempre» con la suma de sus motores, la cuenta de siempre', () => {
    const filas = [
      { aeronave_id: N4142R, monto_por_hora_usd: '55.00' },
      { aeronave_id: N4142R, monto_por_hora_usd: '55.00' },
      { aeronave_id: N621TX, monto_por_hora_usd: 200 },
    ];
    expect(tarifasDeLegado(filas)).toEqual([
      {
        aeronave_id: N4142R,
        vigente_desde: null,
        usd_por_hora: 110,
        motores: 2,
      },
      {
        aeronave_id: N621TX,
        vigente_desde: null,
        usd_por_hora: 200,
        motores: 1,
      },
    ]);
    expect(tarifasDeLegado(filas)[0].usd_por_hora).toBe(
      tarifaReservaOverhaul(filas, N4142R).usd_por_hora,
    );
  });
});

describe('tarifaReservaEnDia', () => {
  const tarifas: TarifaReservaVigente[] = [
    {
      aeronave_id: N4142R,
      vigente_desde: '2026-11-01',
      usd_por_hora: 110,
      motores: 2,
    },
    {
      aeronave_id: N4142R,
      vigente_desde: '2027-01-01',
      usd_por_hora: 120,
      motores: 2,
    },
    { aeronave_id: N621TX, vigente_desde: null, usd_por_hora: 200, motores: 1 },
  ];

  it('vale la de mayor «a partir de» que no sea posterior al día; antes de la primera no hay reserva', () => {
    expect(tarifaReservaEnDia(tarifas, N4142R, '2026-10-31')).toBeNull();
    expect(
      tarifaReservaEnDia(tarifas, N4142R, '2026-11-01')?.usd_por_hora,
    ).toBe(110);
    expect(
      tarifaReservaEnDia(tarifas, N4142R, '2026-12-31')?.usd_por_hora,
    ).toBe(110);
    expect(
      tarifaReservaEnDia(tarifas, N4142R, '2027-01-01')?.usd_por_hora,
    ).toBe(120);
  });

  it('una tarifa legada («desde siempre») vale cualquier día y pierde contra una con fecha', () => {
    expect(
      tarifaReservaEnDia(tarifas, N621TX, '2020-01-01')?.usd_por_hora,
    ).toBe(200);
    const mezcla: TarifaReservaVigente[] = [
      ...tarifas,
      {
        aeronave_id: N621TX,
        vigente_desde: '2026-11-01',
        usd_por_hora: 400,
        motores: 1,
      },
    ];
    expect(tarifaReservaEnDia(mezcla, N621TX, '2026-10-31')?.usd_por_hora).toBe(
      200,
    );
    expect(tarifaReservaEnDia(mezcla, N621TX, '2026-11-01')?.usd_por_hora).toBe(
      400,
    );
  });

  it('otro avión no cuenta', () => {
    expect(tarifaReservaEnDia(tarifas, 'otro', '2026-12-01')).toBeNull();
  });
});

describe('reservaOverhaulDelPeriodo', () => {
  /** Septiembre del N4142R: 41.50 h repartidas en tres días. */
  const HORAS_SEP: Array<[string, number]> = [
    ['2026-09-03', 12.3],
    ['2026-09-15', 20.1],
    ['2026-09-28', 9.1],
  ];

  it('UNA tarifa para todo el periodo: la cuenta de siempre, byte a byte, sobre el acumulado de siempre', () => {
    // 12.3 + 20.1 + 9.1 en flotante NO es 41.5 exacto; el acumulado que ya
    // sumaban el reparto y el balance es el que manda.
    const horasTotal = 41.5;
    const r = reservaOverhaulDelPeriodo({
      tarifas: [
        {
          aeronave_id: N4142R,
          vigente_desde: null,
          usd_por_hora: 110,
          motores: 2,
        },
      ],
      aeronaveId: N4142R,
      horasPorDia: HORAS_SEP,
      horasTotal,
      hasta: '2026-09-30',
    });
    expect(r).toEqual({
      usd: reservaOverhaulPeriodoUsd(horasTotal, 110),
      horas_hr: 41.5,
      tramos: [
        {
          vigente_desde: null,
          usd_por_hora: 110,
          motores: 2,
          horas_hr: 41.5,
          usd: 4565,
        },
      ],
      horas_sin_tarifa_hr: 0,
      primera_vigencia: null,
      usd_por_hora: 110,
      motores: 2,
      incompleta: false,
      con_vigencia: false,
    });
  });

  it('el caso del cliente: «a partir del 1-nov» ⇒ septiembre (ya entregado sin reserva) queda en $0 y NO es un pendiente', () => {
    const r = reservaOverhaulDelPeriodo({
      tarifas: [
        {
          aeronave_id: N4142R,
          vigente_desde: '2026-11-01',
          usd_por_hora: 110,
          motores: 2,
        },
      ],
      aeronaveId: N4142R,
      horasPorDia: HORAS_SEP,
      horasTotal: 41.5,
      hasta: '2026-09-30',
    });
    expect(r).toMatchObject({
      usd: 0,
      horas_hr: 41.5,
      tramos: [],
      horas_sin_tarifa_hr: 41.5,
      primera_vigencia: '2026-11-01',
      // Aún no vale ninguna el 30-sep.
      usd_por_hora: 0,
      motores: 0,
      incompleta: false,
      con_vigencia: true,
    });
  });

  it('un periodo que CRUZA el «a partir de»: solo las horas desde ese día generan reserva', () => {
    const r = reservaOverhaulDelPeriodo({
      tarifas: [
        {
          aeronave_id: N4142R,
          vigente_desde: '2026-09-15',
          usd_por_hora: 110,
          motores: 2,
        },
      ],
      aeronaveId: N4142R,
      horasPorDia: HORAS_SEP,
      horasTotal: 41.5,
      hasta: '2026-09-30',
    });
    expect(r).toMatchObject({
      // (20.1 + 9.1) h × 110 = 3,212.00
      usd: 3212,
      horas_hr: 41.5,
      tramos: [
        {
          vigente_desde: '2026-09-15',
          usd_por_hora: 110,
          horas_hr: 29.2,
          usd: 3212,
        },
      ],
      horas_sin_tarifa_hr: 12.3,
      primera_vigencia: '2026-09-15',
      usd_por_hora: 110,
      incompleta: false,
    });
  });

  it('cambio de tarifa a medio periodo: cada tramo con la suya y el total es la suma', () => {
    const r = reservaOverhaulDelPeriodo({
      tarifas: [
        {
          aeronave_id: N4142R,
          vigente_desde: '2026-01-01',
          usd_por_hora: 110,
          motores: 2,
        },
        {
          aeronave_id: N4142R,
          vigente_desde: '2026-09-15',
          usd_por_hora: 120,
          motores: 2,
        },
      ],
      aeronaveId: N4142R,
      horasPorDia: HORAS_SEP,
      horasTotal: 41.5,
      hasta: '2026-09-30',
    });
    expect(r.tramos).toEqual([
      {
        vigente_desde: '2026-01-01',
        usd_por_hora: 110,
        motores: 2,
        horas_hr: 12.3,
        usd: 1353,
      },
      {
        vigente_desde: '2026-09-15',
        usd_por_hora: 120,
        motores: 2,
        horas_hr: 29.2,
        usd: 3504,
      },
    ]);
    expect(r.usd).toBe(4857);
    expect(r.horas_sin_tarifa_hr).toBe(0);
    // Para los textos de un renglón: la última con horas.
    expect(r.usd_por_hora).toBe(120);
  });

  it('una vigencia en $0 («sin reserva desde tal día») no es un pendiente', () => {
    const r = reservaOverhaulDelPeriodo({
      tarifas: [
        {
          aeronave_id: N4142R,
          vigente_desde: '2026-01-01',
          usd_por_hora: 0,
          motores: 2,
        },
      ],
      aeronaveId: N4142R,
      horasPorDia: HORAS_SEP,
      horasTotal: 41.5,
      hasta: '2026-09-30',
    });
    expect(r).toMatchObject({
      usd: 0,
      incompleta: false,
      horas_sin_tarifa_hr: 0,
    });
  });

  it('voló y el avión no tiene NINGUNA tarifa ⇒ incompleta (hay que capturarla)', () => {
    const r = reservaOverhaulDelPeriodo({
      tarifas: [
        {
          aeronave_id: N621TX,
          vigente_desde: null,
          usd_por_hora: 200,
          motores: 1,
        },
      ],
      aeronaveId: N4142R,
      horasPorDia: HORAS_SEP,
      horasTotal: 41.5,
      hasta: '2026-09-30',
    });
    expect(r).toMatchObject({
      usd: 0,
      tramos: [],
      horas_sin_tarifa_hr: 41.5,
      primera_vigencia: null,
      incompleta: true,
      // Sin tarifa propia no hay vigencia que contar: contrato de siempre.
      con_vigencia: false,
    });
  });

  it('sin horas: $0 y la tarifa que se informa es la vigente al cierre del periodo', () => {
    const r = reservaOverhaulDelPeriodo({
      tarifas: [
        {
          aeronave_id: N4142R,
          vigente_desde: '2026-01-01',
          usd_por_hora: 110,
          motores: 2,
        },
      ],
      aeronaveId: N4142R,
      horasPorDia: [],
      horasTotal: 0,
      hasta: '2026-09-30',
    });
    expect(r).toMatchObject({
      usd: 0,
      horas_hr: 0,
      tramos: [],
      usd_por_hora: 110,
      motores: 2,
      incompleta: false,
    });
  });
});
