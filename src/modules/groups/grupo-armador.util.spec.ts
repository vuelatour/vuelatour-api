import {
  consolidarDesgloses,
  diagnosticoGrupo,
  duplicadosDePiloto,
  escalonarSalidas,
  estadoGrupoDe,
  materializarExtras,
  normalizarExtrasGrupo,
  proponerFlota,
  repartirAjuste,
  repartirExacto,
  tramosDeHijo,
  type ExtraGrupoDef,
  type FichaAvionArmador,
  type PlantillaTramo,
} from './grupo-armador.util';

/**
 * Cotización de GRUPO — helpers puros. Caso real del diseño (4-sep-2026):
 * 44 pax CUN→CZA→CUN con la flota activa (39 asientos) y tour 44 × $85.
 */

const flota: FichaAvionArmador[] = [
  {
    id: 'kodiak',
    matricula: 'N621TX',
    modelo: 'Kodiak 100',
    asientos: 9,
    activa: true,
    tarifa_hora_pub_usd: 1750,
    tarifa_hora_broker_usd: 1650,
  },
  {
    id: 'meridian',
    matricula: 'N58BT',
    modelo: 'Piper Meridian',
    asientos: 5,
    activa: true,
    tarifa_hora_pub_usd: 1650,
    tarifa_hora_broker_usd: 1600,
  },
  {
    id: 'seneca1',
    matricula: 'N4142R',
    modelo: 'Seneca V',
    asientos: 5,
    activa: true,
    tarifa_hora_pub_usd: 1050,
    tarifa_hora_broker_usd: 950,
  },
  {
    id: 'seneca2',
    matricula: 'N990GG',
    modelo: 'Seneca V',
    asientos: 5,
    activa: true,
    tarifa_hora_pub_usd: 1050,
    tarifa_hora_broker_usd: 950,
  },
  {
    id: 'c206',
    matricula: 'XA-VGV',
    modelo: 'Cessna 206',
    asientos: 5,
    activa: true,
    tarifa_hora_pub_usd: 750,
    tarifa_hora_broker_usd: 650,
  },
  {
    id: 'c182',
    matricula: 'XB-ANU',
    modelo: 'Cessna 182',
    asientos: 5,
    activa: true,
    tarifa_hora_pub_usd: 650,
    tarifa_hora_broker_usd: 590,
  },
  {
    id: 'c205',
    matricula: 'XB-PEV',
    modelo: 'Cessna 205',
    asientos: 5,
    activa: true,
    tarifa_hora_pub_usd: 750,
    tarifa_hora_broker_usd: 650,
  },
  {
    id: 'inactivo',
    matricula: 'XB-IJP',
    modelo: 'C206',
    asientos: 5,
    activa: false,
    tarifa_hora_pub_usd: 750,
    tarifa_hora_broker_usd: 650,
  },
];

const plantilla: PlantillaTramo[] = [
  { origen_iata: 'CUN', destino_iata: 'CZA', millas_nauticas: 90 },
  { origen_iata: 'CZA', destino_iata: 'CUN', millas_nauticas: 90 },
];

function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return Math.round(s * 100) / 100;
}

describe('proponerFlota (greedy por asientos)', () => {
  it('cubre 30 pax con los aviones más grandes primero y llena cada uno', () => {
    const p = proponerFlota(flota, 30);
    expect(p.faltan).toBe(0);
    expect(p.aviones[0]).toEqual({
      aeronave_id: 'kodiak',
      pax: 9,
      rotaciones: 1,
    });
    expect(sum(p.aviones.map((a) => a.pax))).toBe(30);
    // El último recibe el resto (9 + 5×4 = 29 → el quinto de 5 lleva 1).
    expect(p.aviones[p.aviones.length - 1].pax).toBe(1);
    expect(p.aviones.length).toBe(6);
  });

  it('44 pax > 39 asientos activos: propone TODA la flota activa llena y reporta faltan 5', () => {
    const p = proponerFlota(flota, 44);
    expect(p.aviones.length).toBe(7);
    expect(p.aviones.some((a) => a.aeronave_id === 'inactivo')).toBe(false);
    expect(p.asientos_total).toBe(39);
    expect(sum(p.aviones.map((a) => a.pax))).toBe(39);
    expect(p.faltan).toBe(5);
  });
});

describe('tramosDeHijo (rotaciones)', () => {
  it('1 rotación: la plantilla con el pax del hijo (ferry ⇒ 0)', () => {
    const r = tramosDeHijo(
      [
        ...plantilla,
        {
          origen_iata: 'CUN',
          destino_iata: 'CUN',
          millas_nauticas: 10,
          es_ferry: true,
        },
      ],
      9,
      1,
      9,
    );
    expect(r.tramos.map((t) => t.pasajeros)).toEqual([9, 9, 0]);
    expect(r.pax_por_rotacion).toEqual([9]);
  });

  it('2 rotaciones: ida(w1) · regreso ferry · ida(w2) · regreso(w1) · ida ferry · regreso(w2), llenando asientos', () => {
    const r = tramosDeHijo(plantilla, 10, 2, 5);
    expect(r.pax_por_rotacion).toEqual([5, 5]);
    expect(
      r.tramos.map(
        (t) =>
          `${t.origen_iata}>${t.destino_iata}:${t.es_ferry ? 'F' : t.pasajeros}`,
      ),
    ).toEqual([
      'CUN>CZA:5',
      'CZA>CUN:F',
      'CUN>CZA:5',
      'CZA>CUN:5',
      'CUN>CZA:F',
      'CZA>CUN:5',
    ]);
    // Los ferries no pernoctan ni traen servicio.
    expect(
      r.tramos.filter((t) => t.es_ferry).every((t) => !t.requiere_pernocta),
    ).toBe(true);
  });

  it('2 rotaciones con 7 pax en 5 asientos: 5 + 2', () => {
    const r = tramosDeHijo(plantilla, 7, 2, 5);
    expect(r.pax_por_rotacion).toEqual([5, 2]);
    expect(r.tramos[2].pasajeros).toBe(2);
    expect(r.tramos[5].pasajeros).toBe(2);
  });

  it('rechaza doble rotación en itinerarios que no son ida y vuelta o que no la necesitan', () => {
    expect(() => tramosDeHijo([plantilla[0]], 10, 2, 5)).toThrow(
      /ida y vuelta/,
    );
    expect(() => tramosDeHijo(plantilla, 4, 2, 5)).toThrow(
      /no necesita doble rotación/,
    );
  });
});

describe('repartirExacto / repartirAjuste (pesos exactos, residuo al ancla)', () => {
  it('Σ partes == monto exacto y el residuo cae en el ancla', () => {
    const pesos = new Map([
      ['a', 3552],
      ['b', 2495],
      ['c', 2090],
    ]);
    const partes = repartirExacto(-1.31, pesos, 'a');
    expect(sum(partes.values())).toBe(-1.31);
    // Pesos exactos (no a 4 decimales): a ≈ 43.6 %, b ≈ 30.7 %, c ≈ 25.7 %.
    expect(partes.get('a')).toBe(-0.57);
    expect(partes.get('b')).toBe(-0.4);
    expect(partes.get('c')).toBe(-0.34);
  });

  it('ajuste 0 ⇒ todas las partes 0; bases 0 ⇒ todo al ancla', () => {
    const bases = new Map([
      ['a', 0],
      ['b', 0],
    ]);
    expect([...repartirAjuste(0, bases, 'b').values()]).toEqual([0, 0]);
    const todo = repartirAjuste(-10, bases, 'b');
    expect(todo.get('b')).toBe(-10);
    expect(todo.get('a')).toBe(0);
  });

  it('centavos por residuo mayor: 100 entre 3 iguales = 33.34 / 33.33 / 33.33 con el extra al ancla', () => {
    const p = repartirExacto(
      100,
      new Map([
        ['x', 1],
        ['y', 1],
        ['z', 1],
      ]),
      'y',
    );
    expect(sum(p.values())).toBe(100);
    expect(p.get('y')).toBe(33.34);
  });
});

describe('materializarExtras', () => {
  const hijos = [
    { key: 'k', pax: 9 },
    { key: 'm', pax: 5 },
    { key: 's1', pax: 5 },
    { key: 's2', pax: 5 },
    { key: 'v', pax: 5 },
    { key: 'p', pax: 5 },
    { key: 'anu', pax: 10 },
  ];
  const tour: ExtraGrupoDef = {
    id: 'tour',
    concepto: 'Tour Chichén Itzá',
    cantidad: null,
    unitario: 85,
    moneda: 'USD',
    aplica_iva: true,
    por_persona: true,
    reparto: 'POR_PAX',
  };

  it('POR_PAX por persona: cantidad_i = pax_i, origen GRUPO, Σ partes == 44 × 85', () => {
    const m = materializarExtras([tour], hijos, 'anu', 44);
    const lineas = hijos.map((h) => m.get(h.key)![0]);
    expect(lineas.map((l) => l.cantidad)).toEqual([9, 5, 5, 5, 5, 5, 10]);
    expect(
      lineas.every(
        (l) =>
          l.origen === 'GRUPO' &&
          l.grupo_extra_id === 'tour' &&
          l.unitario === 85,
      ),
    ).toBe(true);
    expect(lineas.every((l) => l.por_persona === true)).toBe(true);
    const total = sum(lineas.map((l) => (l.cantidad ?? 0) * (l.unitario ?? 0)));
    expect(total).toBe(44 * 85);
  });

  it('PROPORCIONAL: el monto total se reparte por pax con pesos exactos (Σ == total)', () => {
    const guia: ExtraGrupoDef = {
      ...tour,
      id: 'guia',
      concepto: 'Guía',
      cantidad: 1,
      unitario: 1000,
      por_persona: false,
      reparto: 'PROPORCIONAL',
    };
    const m = materializarExtras([guia], hijos, 'anu', 44);
    const partes = hijos.map((h) => m.get(h.key)![0].monto_usd);
    expect(sum(partes)).toBe(1000);
    // Pesos exactos 9/44, 5/44 ×5 y 10/44: pisos 204.54 / 113.63 / 227.27
    // dejan 4 centavos que caen en los residuos MAYORES (los 0.636 de los
    // aviones de 5 pax), no en el ancla ni en el mayor.
    expect(partes[0]).toBe(204.54);
    expect(partes[6]).toBe(227.27);
    expect(partes.slice(1, 6).filter((p) => p === 113.64)).toHaveLength(4);
    expect(m.get('k')![0].cantidad).toBeUndefined();
  });

  it('ANCLA: toda la línea (cantidad × unitario) en el ancla; los demás sin línea', () => {
    const vans: ExtraGrupoDef = {
      ...tour,
      id: 'vans',
      concepto: 'Camionetas',
      cantidad: 3,
      unitario: 200,
      por_persona: false,
      reparto: 'ANCLA',
    };
    const m = materializarExtras([vans], hijos, 'k', 44);
    expect(m.get('k')).toEqual([
      expect.objectContaining({
        cantidad: 3,
        unitario: 200,
        origen: 'GRUPO',
        grupo_extra_id: 'vans',
      }),
    ]);
    expect(
      hijos
        .filter((h) => h.key !== 'k')
        .every((h) => m.get(h.key)!.length === 0),
    ).toBe(true);
  });

  it('normalizarExtrasGrupo: defaults y descarte de líneas vacías', () => {
    const defs = normalizarExtrasGrupo(
      [
        { concepto: ' Tour ', unitario: 85 },
        { concepto: 'Vacío', unitario: 0 },
        {
          id: '11111111-1111-1111-1111-111111111111',
          concepto: 'Guía',
          unitario: 500,
          cantidad: 2,
          reparto: 'ANCLA',
          moneda: 'MXN',
          aplica_iva: false,
        },
      ],
      () => 'nuevo-id',
    );
    expect(defs).toHaveLength(2);
    expect(defs[0]).toEqual(
      expect.objectContaining({
        id: 'nuevo-id',
        concepto: 'Tour',
        por_persona: true,
        reparto: 'POR_PAX',
        moneda: 'USD',
        aplica_iva: true,
      }),
    );
    expect(defs[1]).toEqual(
      expect.objectContaining({
        id: '11111111-1111-1111-1111-111111111111',
        cantidad: 2,
        por_persona: false,
        reparto: 'ANCLA',
        moneda: 'MXN',
        aplica_iva: false,
      }),
    );
  });
});

describe('consolidarDesgloses (lector puro de desgloses persistidos)', () => {
  /** Snapshot mínimo de un hijo con desglose canónico que suma exacto. */
  function hijo(
    key: string,
    posicion: number,
    matricula: string,
    tiempo: number,
    tuas: Array<{ iata: string; total: number; pax: number }>,
    tourPax: number,
    iva: number,
    opts: { ajuste?: number; cancelado?: boolean } = {},
  ) {
    const tourMonto = Math.round(tourPax * 85 * 100) / 100;
    const desglose = [
      { clave: 'TIEMPO_VUELO', concepto: 'Tiempo de vuelo', monto_usd: tiempo },
      ...tuas.map((t) => ({
        clave: 'TUAS',
        concepto: `TUA ${t.iata}`,
        monto_usd: t.total,
      })),
      {
        clave: 'EXTRA',
        concepto: `Tour Chichén Itzá · ${tourPax} × $85.00`,
        monto_usd: tourMonto,
      },
      ...(opts.ajuste
        ? [{ clave: 'AJUSTE', concepto: 'Descuento', monto_usd: opts.ajuste }]
        : []),
      { clave: 'IVA', concepto: 'IVA 16%', monto_usd: iva },
    ];
    const total =
      Math.round(desglose.reduce((a, d) => a + d.monto_usd, 0) * 100) / 100;
    return {
      key,
      posicion,
      matricula,
      cancelado: opts.cancelado,
      calculo_snapshot: {
        desglose,
        extras: [
          {
            concepto: 'Tour Chichén Itzá',
            monto_usd: tourMonto,
            moneda: 'USD',
            cantidad: tourPax,
            unitario: 85,
            origen: 'GRUPO',
            grupo_extra_id: 'tour',
            aplica_iva: true,
          },
        ],
        tuas: {
          filas: tuas.map((t) => ({
            iata: t.iata,
            total_usd: t.total,
            pax: t.pax,
          })),
        },
        tiempos: { cobrable_hr: 1.5 },
      },
      total_usd: total,
      total_mxn: Math.round(total * 18.5 * 100) / 100,
    };
  }

  it('Σ por clave == Σ totales de los hijos vivos; EXTRA agrupado por grupo_extra_id; TUAS por aeropuerto', () => {
    const hijos = [
      hijo(
        'k',
        1,
        'N621TX',
        2625,
        [{ iata: 'CZA', total: 162, pax: 9 }],
        9,
        568.32,
      ),
      hijo(
        'm',
        2,
        'N58BT',
        1980,
        [{ iata: 'CZA', total: 90, pax: 5 }],
        5,
        399.2,
      ),
      hijo(
        'v',
        5,
        'XA-VGV',
        1350,
        [
          { iata: 'CUN', total: 125, pax: 5 },
          { iata: 'CZA', total: 90, pax: 5 },
        ],
        5,
        318.4,
      ),
      hijo(
        'anu',
        7,
        'XB-ANU',
        3510,
        [{ iata: 'CZA', total: 180, pax: 10 }],
        10,
        726.4,
      ),
      hijo('x', 8, 'XB-XXX', 999, [{ iata: 'CZA', total: 99, pax: 1 }], 1, 1, {
        cancelado: true,
      }),
    ];
    const c = consolidarDesgloses(hijos, 44);
    expect(c.aviones).toBe(4);
    expect(c.verificacion.cuadra).toBe(true);
    expect(c.total_usd).toBe(
      sum(hijos.filter((h) => !h.cancelado).map((h) => h.total_usd)),
    );
    expect(c.subtotal_aereo_usd).toBe(2625 + 1980 + 1350 + 3510);
    const tuas = c.desglose.filter((l) => l.clave === 'TUAS');
    expect(tuas.map((l) => [l.iata, l.monto_usd, l.pax])).toEqual([
      ['CZA', 522, 29],
      ['CUN', 125, 5],
    ]);
    const tour = c.desglose.find((l) => l.clave === 'EXTRA')!;
    expect(tour.grupo_extra_id).toBe('tour');
    expect(tour.cantidad).toBe(29);
    expect(tour.unitario).toBe(85);
    expect(tour.monto_usd).toBe(29 * 85);
    expect(tour.concepto).toBe('Tour Chichén Itzá · 29 × $85.00');
    expect(tour.por_avion.map((p) => p.matricula)).toEqual([
      'N621TX',
      'N58BT',
      'XA-VGV',
      'XB-ANU',
    ]);
    expect(c.iva_usd).toBe(sum([568.32, 399.2, 318.4, 726.4]));
    expect(c.horas_total_hr).toBe(6);
    expect(c.por_persona_usd).toBe(Math.round((c.total_usd / 44) * 100) / 100);
    expect(c.total_mxn).toBe(
      sum(hijos.filter((h) => !h.cancelado).map((h) => h.total_mxn)),
    );
  });

  it('el AJUSTE consolidado suma los de los hijos y se etiqueta Descuento cuando es negativo', () => {
    const c = consolidarDesgloses(
      [
        hijo('a', 1, 'A', 1000, [], 2, 160, { ajuste: -0.57 }),
        hijo('b', 2, 'B', 1000, [], 2, 160, { ajuste: -0.74 }),
      ],
      4,
    );
    const aj = c.desglose.find((l) => l.clave === 'AJUSTE')!;
    expect(aj.monto_usd).toBe(-1.31);
    expect(aj.concepto).toBe('Descuento');
    expect(c.verificacion.cuadra).toBe(true);
  });

  it('sin hijos vivos: consolidado vacío y total 0', () => {
    const c = consolidarDesgloses(
      [hijo('x', 1, 'X', 1, [], 1, 0, { cancelado: true })],
      44,
    );
    expect(c.aviones).toBe(0);
    expect(c.total_usd).toBe(0);
    expect(c.desglose).toEqual([]);
    expect(c.total_mxn).toBeNull();
  });
});

describe('escalonarSalidas', () => {
  it('el de doble vuelta sale primero; 10 min entre aviones; salida explícita se respeta', () => {
    const base = new Date('2026-09-20T13:00:00.000Z');
    const s = escalonarSalidas(base, [
      { key: 'a', rotaciones: 1 },
      { key: 'b', rotaciones: 2 },
      {
        key: 'c',
        rotaciones: 1,
        fecha_salida_plan: '2026-09-20T15:00:00.000Z',
      },
      { key: 'd', rotaciones: 1 },
    ]);
    expect(s.get('b')!.toISOString()).toBe('2026-09-20T13:00:00.000Z');
    expect(s.get('a')!.toISOString()).toBe('2026-09-20T13:10:00.000Z');
    expect(s.get('c')!.toISOString()).toBe('2026-09-20T15:00:00.000Z');
    expect(s.get('d')!.toISOString()).toBe('2026-09-20T13:20:00.000Z');
  });

  it('un avión nuevo no pisa la salida explícita de otro: toma el siguiente hueco', () => {
    const base = new Date('2026-09-20T13:00:00.000Z');
    const s = escalonarSalidas(base, [
      { key: 'viejo', rotaciones: 1, fecha_salida_plan: base },
      { key: 'nuevo', rotaciones: 1 },
    ]);
    expect(s.get('viejo')!.toISOString()).toBe('2026-09-20T13:00:00.000Z');
    expect(s.get('nuevo')!.toISOString()).toBe('2026-09-20T13:10:00.000Z');
  });
});

describe('duplicadosDePiloto', () => {
  it('detecta el mismo piloto en dos hijos y piloto = copiloto del mismo hijo', () => {
    const d = duplicadosDePiloto([
      { key: '1', piloto_id: 'juan', copiloto_id: null },
      { key: '2', piloto_id: 'pedro', copiloto_id: 'juan' },
      { key: '3', piloto_id: 'luis', copiloto_id: 'luis' },
      { key: '4', piloto_id: 'ana' },
    ]);
    expect(d).toEqual([
      { usuario_id: 'juan', posiciones: ['1', '2'] },
      { usuario_id: 'luis', posiciones: ['3', '3'] },
    ]);
  });
});

describe('estadoGrupoDe', () => {
  const e = (...xs: string[]) => xs.map((estado) => ({ estado }));
  it('deriva el estado de los hijos vivos', () => {
    expect(estadoGrupoDe(e('COTIZADO', 'COTIZADO'), null)).toBe('COTIZADO');
    expect(estadoGrupoDe(e('RESERVA', 'RESERVA'), null)).toBe('RESERVA');
    expect(estadoGrupoDe(e('CONFIRMADO', 'COTIZADO'), null)).toBe(
      'CONFIRMADO_PARCIAL',
    );
    expect(
      estadoGrupoDe(e('CONFIRMADO', 'CONFIRMADO', 'CANCELADO'), null),
    ).toBe('CONFIRMADO');
    expect(estadoGrupoDe(e('EN_VUELO', 'CONFIRMADO'), null)).toBe('EN_CURSO');
    expect(estadoGrupoDe(e('COMPLETADO', 'CONFIRMADO'), null)).toBe('EN_CURSO');
    expect(estadoGrupoDe(e('COMPLETADO', 'CANCELADO'), null)).toBe(
      'COMPLETADO',
    );
    expect(estadoGrupoDe(e('CANCELADO', 'CANCELADO'), null)).toBe('CANCELADO');
    expect(estadoGrupoDe(e('COTIZADO'), '2026-09-04T00:00:00Z')).toBe(
      'CANCELADO',
    );
  });
});

describe('diagnosticoGrupo', () => {
  const tour: ExtraGrupoDef = {
    id: 'tour',
    concepto: 'Tour',
    cantidad: null,
    unitario: 85,
    moneda: 'USD',
    aplica_iva: true,
    por_persona: true,
    reparto: 'POR_PAX',
  };
  const linea = (cantidad: number, unitario = 85) => ({
    concepto: 'Tour',
    cantidad,
    unitario,
    moneda: 'USD',
    aplica_iva: true,
    origen: 'GRUPO',
    grupo_extra_id: 'tour',
  });

  it('sin problemas cuando pax y extras cuadran', () => {
    const p = diagnosticoGrupo({ pasajeros_total: 14, extras_grupo: [tour] }, [
      {
        posicion: 1,
        folio: 10,
        grupo_pax: 9,
        extras: [linea(9)],
        calculo_snapshot: {},
      },
      {
        posicion: 2,
        folio: 11,
        grupo_pax: 5,
        extras: [linea(5)],
        calculo_snapshot: {},
      },
    ]);
    expect(p).toEqual([]);
  });

  it('detecta Σ pax ≠ total, precio desactualizado, extra editado y extra faltante', () => {
    const p = diagnosticoGrupo({ pasajeros_total: 14, extras_grupo: [tour] }, [
      {
        posicion: 1,
        folio: 10,
        grupo_pax: 9,
        extras: [linea(9, 80)],
        calculo_snapshot: { meta: { grupo: { precio_desactualizado: true } } },
      },
      {
        posicion: 2,
        folio: 11,
        grupo_pax: 4,
        extras: [],
        calculo_snapshot: {},
      },
    ]);
    expect(p.map((x) => x.tipo)).toEqual([
      'PAX',
      'PRECIO_DESACTUALIZADO',
      'EXTRAS',
      'EXTRAS',
    ]);
    expect(p[2].detalle).toMatch(/unitario 80/);
    expect(p[3].detalle).toMatch(/falta el extra/);
  });
});
