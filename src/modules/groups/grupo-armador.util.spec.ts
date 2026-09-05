import {
  consolidarDesgloses,
  diagnosticoGrupo,
  duplicadosDePiloto,
  escalonarSalidas,
  estadoGrupoDe,
  materializarExtras,
  normalizarExtrasGrupo,
  normalizarTuasLineas,
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
  interface TuaHijo {
    iata: string;
    total: number;
    pax: number;
    /** Unitario nativo; default total / pax. */
    unitario?: number;
  }
  /** Snapshot mínimo de un hijo con desglose canónico que suma exacto. */
  function hijo(
    key: string,
    posicion: number,
    matricula: string,
    tiempo: number,
    tuas: TuaHijo[],
    tourPax: number,
    iva: number,
    opts: {
      ajuste?: number;
      cancelado?: boolean;
      tarifa?: number;
      modelo?: string;
      /** Aeropuertos donde ESTE avión quedó exento (aplica=false). */
      exentos?: Array<{ iata: string; razon: string }>;
      /** Snapshot viejo: sin tuas.aeropuertos ni tramos. */
      sinItinerario?: boolean;
    } = {},
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
    const exentoEn = (iata: string) =>
      (opts.exentos ?? []).find((e) => e.iata === iata);
    return {
      key,
      posicion,
      matricula,
      cancelado: opts.cancelado,
      calculo_snapshot: {
        aeronave: { modelo: opts.modelo ?? null },
        desglose,
        extras: [
          {
            concepto: 'Tour Chichén Itzá',
            monto_usd: tourMonto,
            monto_nativo: tourMonto,
            moneda: 'USD',
            cantidad: tourPax,
            unitario: 85,
            origen: 'GRUPO',
            grupo_extra_id: 'tour',
            aplica_iva: true,
          },
        ],
        tuas: {
          pasajeros: tourPax,
          ...(opts.sinItinerario
            ? {}
            : {
                aeropuertos: ['CUN', 'CZA'].map((iata) => ({
                  iata,
                  aplica: !exentoEn(iata),
                  razon: exentoEn(iata)?.razon ?? 'Catálogo',
                })),
              }),
          filas: tuas.map((t) => {
            const unitario = t.unitario ?? t.total / t.pax;
            return {
              iata: t.iata,
              total_usd: t.total,
              total_nativo: t.total,
              pax: t.pax,
              monto_pax: unitario,
              usd_pax: unitario,
              moneda: 'USD',
              razon: 'Catálogo',
            };
          }),
        },
        tiempos: { cobrable_hr: 1.5 },
        ...(opts.tarifa != null
          ? { tarifa: { usd_por_hora: opts.tarifa } }
          : {}),
        iva: {
          porcentaje: 0.16,
          base_usd: Math.round((iva / 0.16) * 100) / 100,
        },
        ...(opts.sinItinerario
          ? {}
          : {
              tramos: [
                {
                  origen: 'CUN',
                  destino: 'CZA',
                  pasajeros: tourPax,
                  es_ferry: false,
                },
                {
                  origen: 'CZA',
                  destino: 'CUN',
                  pasajeros: tourPax,
                  es_ferry: false,
                },
              ],
            }),
      },
      total_usd: total,
      total_mxn: Math.round(total * 18.5 * 100) / 100,
    };
  }

  it('Σ por clave == Σ totales de los hijos vivos; EXTRA agrupado por grupo_extra_id; TUAS por aeropuerto (orden del itinerario, exentos por prefijo)', () => {
    const exentoCun = [{ iata: 'CUN', razon: 'Matricula N exenta en CUN' }];
    const hijos = [
      hijo(
        'k',
        1,
        'N621TX',
        2625,
        [{ iata: 'CZA', total: 162, pax: 9 }],
        9,
        568.32,
        { tarifa: 1750, modelo: 'Kodiak 100', exentos: exentoCun },
      ),
      hijo(
        'm',
        2,
        'N58BT',
        1980,
        [{ iata: 'CZA', total: 90, pax: 5 }],
        5,
        399.2,
        { tarifa: 1320, modelo: 'Piper Meridian', exentos: exentoCun },
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
        { tarifa: 900, modelo: 'Cessna 206' },
      ),
      hijo(
        'anu',
        7,
        'XB-ANU',
        3510,
        [{ iata: 'CZA', total: 180, pax: 10 }],
        10,
        726.4,
        { tarifa: 2340, modelo: 'Cessna 182' },
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
    // Servicio aéreo: operación visible por avión (horas × tarifa del snapshot).
    const servicio = c.desglose[0];
    expect(servicio.clave).toBe('TIEMPO_VUELO');
    expect(servicio.operacion).toEqual({
      tipo: 'SERVICIO',
      aviones: 4,
      horas_total_hr: 6,
    });
    expect(servicio.por_avion[0]).toEqual({
      key: 'k',
      posicion: 1,
      matricula: 'N621TX',
      modelo: 'Kodiak 100',
      monto_usd: 2625,
      horas_hr: 1.5,
      tarifa_hora_usd: 1750,
    });
    // TUAS: orden del itinerario (CUN antes que CZA aunque el primer hijo
    // sea exento en CUN); pax gravados por línea.
    const tuas = c.desglose.filter((l) => l.clave === 'TUAS');
    expect(tuas.map((l) => [l.iata, l.monto_usd, l.pax])).toEqual([
      ['CUN', 125, 5],
      ['CZA', 522, 29],
    ]);
    const cun = tuas[0];
    expect([cun.cantidad, cun.unitario, cun.moneda]).toEqual([5, 25, 'USD']);
    expect(cun.operacion?.tipo).toBe('TUAS');
    if (cun.operacion?.tipo !== 'TUAS') throw new Error('operacion TUAS');
    expect(cun.operacion.pax_gravados).toBe(5);
    expect(cun.operacion.pax_exentos).toBe(14);
    expect(cun.operacion.unitario_usd).toBe(25);
    expect(cun.operacion.total_nativo).toBe(125);
    expect(
      cun.operacion.aviones_exentos.map((a) => [a.matricula, a.pax]),
    ).toEqual([
      ['N621TX', 9],
      ['N58BT', 5],
    ]);
    expect(
      cun.por_avion.filter((p) => p.exento).map((p) => p.matricula),
    ).toEqual(['N621TX', 'N58BT']);
    expect(cun.por_avion.find((p) => !p.exento)).toEqual({
      key: 'v',
      posicion: 5,
      matricula: 'XA-VGV',
      modelo: 'Cessna 206',
      monto_usd: 125,
      pax: 5,
      exento: false,
    });
    const cza = tuas[1];
    if (cza.operacion?.tipo !== 'TUAS') throw new Error('operacion TUAS');
    expect(cza.operacion.unitario).toBe(18);
    expect(cza.operacion.pax_exentos).toBe(0);
    expect(cza.operacion.detalle_por_avion).toHaveLength(4);
    // Apartado TUAS del consolidado (mismo agregado).
    expect(
      c.tuas.aeropuertos.map((a) => [
        a.iata,
        a.monto_usd,
        a.pax_gravados,
        a.pax_exentos,
        a.unitario,
      ]),
    ).toEqual([
      ['CUN', 125, 5, 14, 25],
      ['CZA', 522, 29, 0, 18],
    ]);
    expect(c.tuas.total_usd).toBe(647);
    expect(c.tuas_usd).toBe(647);
    const tour = c.desglose.find((l) => l.clave === 'EXTRA')!;
    expect(tour.grupo_extra_id).toBe('tour');
    expect(tour.cantidad).toBe(29);
    expect(tour.unitario).toBe(85);
    expect(tour.monto_usd).toBe(29 * 85);
    expect(tour.concepto).toBe('Tour Chichén Itzá · 29 × $85.00');
    expect(tour.operacion).toEqual({
      tipo: 'EXTRA',
      cantidad: 29,
      unitario: 85,
      moneda: 'USD',
    });
    expect(tour.por_avion.map((p) => p.matricula)).toEqual([
      'N621TX',
      'N58BT',
      'XA-VGV',
      'XB-ANU',
    ]);
    expect(c.iva_usd).toBe(sum([568.32, 399.2, 318.4, 726.4]));
    const ivaL = c.desglose.find((l) => l.clave === 'IVA')!;
    expect(ivaL.operacion).toEqual({
      tipo: 'IVA',
      pct: 16,
      base_usd: sum([3552, 2495, 1990, 4540]),
    });
    expect(c.horas_total_hr).toBe(6);
    expect(c.por_persona_usd).toBe(Math.round((c.total_usd / 44) * 100) / 100);
    expect(c.por_persona).toEqual({
      total_usd: c.total_usd,
      pasajeros_total: 44,
    });
    expect(c.total_mxn).toBe(
      sum(hijos.filter((h) => !h.cancelado).map((h) => h.total_mxn)),
    );
  });

  it('unitario de TUA NO uniforme entre aviones ⇒ unitario null y manda detalle_por_avion', () => {
    const c = consolidarDesgloses(
      [
        hijo('a', 1, 'XA-A', 1000, [{ iata: 'CZA', total: 90, pax: 5 }], 5, 0),
        hijo('b', 2, 'XA-B', 1000, [{ iata: 'CZA', total: 100, pax: 5 }], 5, 0),
      ],
      10,
    );
    const cza = c.desglose.find((l) => l.clave === 'TUAS')!;
    expect(cza.monto_usd).toBe(190);
    expect(cza.cantidad).toBeUndefined();
    expect(cza.unitario).toBeUndefined();
    if (cza.operacion?.tipo !== 'TUAS') throw new Error('operacion TUAS');
    expect(cza.operacion.unitario).toBeNull();
    expect(cza.operacion.unitario_usd).toBeNull();
    expect(
      cza.operacion.detalle_por_avion.map((d) => [d.matricula, d.unitario]),
    ).toEqual([
      ['XA-A', 18],
      ['XA-B', 20],
    ]);
    // Modelo: sin ficha del hijo cae al snapshot (null aquí).
    expect(cza.por_avion[0].modelo).toBeNull();
  });

  it('aeropuerto donde TODOS son exentos: en el apartado TUAS con $0, fuera del desglose', () => {
    const exento = [{ iata: 'CUN', razon: 'Matricula N exenta en CUN' }];
    const c = consolidarDesgloses(
      [
        hijo('a', 1, 'N1', 1000, [{ iata: 'CZA', total: 90, pax: 5 }], 5, 0, {
          exentos: exento,
        }),
        hijo('b', 2, 'N2', 1000, [{ iata: 'CZA', total: 90, pax: 5 }], 5, 0, {
          exentos: exento,
        }),
      ],
      10,
    );
    expect(
      c.desglose.filter((l) => l.clave === 'TUAS').map((l) => l.iata),
    ).toEqual(['CZA']);
    const cun = c.tuas.aeropuertos.find((a) => a.iata === 'CUN')!;
    expect(cun.monto_usd).toBe(0);
    expect(cun.pax_gravados).toBe(0);
    expect(cun.pax_exentos).toBe(10);
    expect(cun.unitario).toBeNull();
    expect(cun.aviones_exentos.map((a) => a.razon)).toEqual([
      'Matricula N exenta en CUN',
      'Matricula N exenta en CUN',
    ]);
    expect(c.verificacion.cuadra).toBe(true);
  });

  it('aeropuerto que APLICA pero cobra $0 (TUA capturada en $0): se lista gravado a $0.00, fuera del desglose', () => {
    const base = hijo(
      'a',
      1,
      'XA-A',
      1000,
      [{ iata: 'CZA', total: 90, pax: 5 }],
      5,
      0,
    );
    const snap = base.calculo_snapshot as {
      tuas: { aeropuertos: Array<Record<string, unknown>> };
    };
    snap.tuas.aeropuertos = snap.tuas.aeropuertos.map((a) =>
      a.iata === 'CUN'
        ? {
            ...a,
            monto_pax: 0,
            usd_pax: 0,
            moneda: 'USD',
            razon: 'Catálogo · monto capturado',
          }
        : a,
    );
    const c = consolidarDesgloses([base], 5);
    expect(
      c.desglose.filter((l) => l.clave === 'TUAS').map((l) => l.iata),
    ).toEqual(['CZA']);
    const cun = c.tuas.aeropuertos.find((a) => a.iata === 'CUN')!;
    expect(cun.monto_usd).toBe(0);
    expect(cun.pax_gravados).toBe(5);
    expect(cun.pax_exentos).toBe(0);
    expect(cun.unitario).toBe(0);
    expect(cun.moneda).toBe('USD');
    expect(cun.detalle_por_avion).toHaveLength(1);
    expect(cun.detalle_por_avion[0].exento).toBe(false);
    expect(cun.detalle_por_avion[0].razon).toBe('Catálogo · monto capturado');
    // Sin monto_pax/usd_pax en el snapshot (viejo) no se inventa la fila.
    const viejo = hijo(
      'b',
      2,
      'XA-B',
      1000,
      [{ iata: 'CZA', total: 90, pax: 5 }],
      5,
      0,
    );
    expect(
      consolidarDesgloses([viejo], 5).tuas.aeropuertos.map((a) => a.iata),
    ).toEqual(['CZA']);
    expect(c.verificacion.cuadra).toBe(true);
  });

  it('snapshot viejo (sin aeropuertos ni tramos): mismas líneas de siempre, sin exentos', () => {
    const c = consolidarDesgloses(
      [
        hijo('a', 1, 'XA-A', 1000, [{ iata: 'CZA', total: 90, pax: 5 }], 5, 0, {
          sinItinerario: true,
        }),
      ],
      5,
    );
    const cza = c.desglose.find((l) => l.clave === 'TUAS')!;
    expect(cza.iata).toBe('CZA');
    expect(cza.monto_usd).toBe(90);
    if (cza.operacion?.tipo !== 'TUAS') throw new Error('operacion TUAS');
    expect(cza.operacion.pax_exentos).toBe(0);
    expect(c.tuas.aeropuertos.map((a) => a.iata)).toEqual(['CZA']);
  });

  it('extra PROPORCIONAL (partes como MONTO): cantidad × unitario se recupera de la definición SOLO si Σ partes cuadra', () => {
    const parte = (key: string, monto: number, cancelado = false) => ({
      key,
      posicion: key === 'a' ? 1 : 2,
      matricula: key.toUpperCase(),
      cancelado,
      calculo_snapshot: {
        desglose: [
          { clave: 'TIEMPO_VUELO', concepto: 'Tiempo', monto_usd: 1000 },
          { clave: 'EXTRA', concepto: 'Camionetas', monto_usd: monto },
        ],
        extras: [
          {
            concepto: 'Camionetas',
            monto_usd: monto,
            monto_nativo: monto,
            moneda: 'USD',
            origen: 'GRUPO',
            grupo_extra_id: 'van',
            aplica_iva: true,
          },
        ],
        tiempos: { cobrable_hr: 1 },
      },
      total_usd: 1000 + monto,
      total_mxn: null,
    });
    const defs = [
      {
        id: 'van',
        concepto: 'Camionetas',
        cantidad: 3,
        unitario: 850,
        moneda: 'USD' as const,
        aplica_iva: true,
        por_persona: false,
        reparto: 'PROPORCIONAL' as const,
      },
    ];
    const c = consolidarDesgloses(
      [parte('a', 1275.5), parte('b', 1274.5)],
      10,
      defs,
    );
    const van = c.desglose.find((l) => l.clave === 'EXTRA')!;
    expect(van.monto_usd).toBe(2550);
    expect(van.cantidad).toBe(3);
    expect(van.unitario).toBe(850);
    expect(van.concepto).toBe('Camionetas · 3 × $850.00');
    expect(van.operacion).toEqual({
      tipo: 'EXTRA',
      cantidad: 3,
      unitario: 850,
      moneda: 'USD',
    });
    // Un hijo cancelado rompe la igualdad: la operación NO se inventa.
    const c2 = consolidarDesgloses(
      [parte('a', 1275.5), parte('b', 1274.5, true)],
      10,
      defs,
    );
    const van2 = c2.desglose.find((l) => l.clave === 'EXTRA')!;
    expect(van2.monto_usd).toBe(1275.5);
    expect(van2.cantidad).toBeUndefined();
    expect(van2.concepto).toBe('Camionetas');
    expect(van2.operacion).toEqual({
      tipo: 'EXTRA',
      cantidad: null,
      unitario: null,
      moneda: 'USD',
    });
  });

  it('el AJUSTE consolidado suma los de los hijos, se etiqueta Descuento cuando es negativo y expone su base', () => {
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
    // Base = servicio + TUAS + extras + comisión (2 × 1000 + 2 × 170).
    expect(aj.operacion).toEqual({ tipo: 'AJUSTE', base_usd: 2340 });
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
    expect(c.por_persona).toEqual({ total_usd: 0, pasajeros_total: 44 });
    expect(c.tuas).toEqual({
      total_usd: 0,
      total_mxn_nativo: 0,
      aeropuertos: [],
    });
  });
});

describe('normalizarTuasLineas (cabecera → líneas del cotizador)', () => {
  it('normaliza IATA, monto y moneda; descarta basura y duplicados', () => {
    expect(
      normalizarTuasLineas([
        { iata: 'cza', monto_pax: '20.855', moneda: 'USD' },
        { iata: 'CUN', monto_pax: 330.6, moneda: 'MXN' },
        { iata: 'CZA', monto_pax: 1, moneda: 'USD' },
        { iata: 'XX', monto_pax: 1 },
        { iata: 'HOL', monto_pax: -1 },
        { iata: 'PCE', monto_pax: 0 },
        null,
        'x',
      ]),
    ).toEqual([
      { iata: 'CZA', monto_pax: 20.86, moneda: 'USD' },
      { iata: 'CUN', monto_pax: 330.6, moneda: 'MXN' },
      { iata: 'PCE', monto_pax: 0, moneda: 'USD' },
    ]);
    expect(normalizarTuasLineas(null)).toEqual([]);
    expect(normalizarTuasLineas('[]')).toEqual([]);
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
