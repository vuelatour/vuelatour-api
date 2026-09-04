import {
  anclarExtrasDeGrupo,
  cantidadEfectiva,
  etiquetaCantidadUnitario,
  mezclarExtrasDesdeGrupo,
  montoDerivado,
  tieneCantidadUnitario,
} from './extras-grupo.util';

describe('extras con cantidad × unitario', () => {
  it('monto derivado = round2(cantidad × unitario)', () => {
    expect(montoDerivado(9, 85)).toBe(765);
    expect(montoDerivado(44, 85)).toBe(3740);
    expect(montoDerivado(3, 33.335)).toBe(100.01);
    expect(montoDerivado('10', '1500')).toBe(15000);
  });

  it('tieneCantidadUnitario exige ambos y no negativos', () => {
    expect(
      tieneCantidadUnitario({ concepto: 'x', cantidad: 9, unitario: 85 }),
    ).toBe(true);
    expect(
      tieneCantidadUnitario({ concepto: 'x', cantidad: 0, unitario: 85 }),
    ).toBe(true);
    expect(tieneCantidadUnitario({ concepto: 'x', cantidad: 9 })).toBe(false);
    expect(tieneCantidadUnitario({ concepto: 'x', unitario: 85 })).toBe(false);
    expect(
      tieneCantidadUnitario({ concepto: 'x', cantidad: -1, unitario: 85 }),
    ).toBe(false);
  });

  it('etiqueta es-MX con 2 decimales en el unitario', () => {
    expect(etiquetaCantidadUnitario(9, 85)).toBe('9 × $85.00');
    expect(etiquetaCantidadUnitario(44, 1500, 'MXN')).toBe(
      '44 × $1,500.00 MXN',
    );
    expect(etiquetaCantidadUnitario(2.5, 10)).toBe('2.5 × $10.00');
  });

  it('por_persona liga la cantidad a los pax del vuelo; GRUPO conserva la suya', () => {
    expect(
      cantidadEfectiva(
        { concepto: 'Tour', cantidad: 3, unitario: 85, por_persona: true },
        7,
      ),
    ).toBe(7);
    expect(
      cantidadEfectiva(
        {
          concepto: 'Tour',
          cantidad: 10,
          unitario: 85,
          por_persona: true,
          origen: 'GRUPO',
        },
        5, // doble rotación: vuelo.pasajeros = 5, grupo_pax = 10
      ),
    ).toBe(10);
    expect(
      cantidadEfectiva({ concepto: 'Handler', cantidad: 2, unitario: 50 }, 7),
    ).toBe(2);
  });
});

describe('anclarExtrasDeGrupo', () => {
  const tourGrupo = {
    concepto: 'Tour Chichén Itzá',
    cantidad: 9,
    unitario: 85,
    monto_usd: 765,
    moneda: 'USD',
    aplica_iva: true,
    por_persona: true,
    origen: 'GRUPO',
    grupo_extra_id: '11111111-0000-0000-0000-000000000001',
  };
  const handler = { concepto: 'Handler', monto_usd: 150, origen: 'VUELO' };

  it('sin extras de grupo persistidos devuelve lo entrante tal cual (undefined incluido)', () => {
    expect(anclarExtrasDeGrupo([handler], undefined)).toBeUndefined();
    const entrantes = [{ concepto: 'Comisariato', monto_usd: 40 }];
    expect(anclarExtrasDeGrupo([handler], entrantes)).toBe(entrantes);
  });

  it('conserva las líneas GRUPO persistidas aunque el front las mande cambiadas', () => {
    const r = anclarExtrasDeGrupo(
      [tourGrupo, handler],
      [
        { ...tourGrupo, cantidad: 1, unitario: 1 }, // manipulada
        { concepto: 'Comisariato', monto_usd: 40 },
      ],
    )!;
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual(tourGrupo);
    expect(r[1]).toEqual({ concepto: 'Comisariato', monto_usd: 40 });
  });

  it('no duplica una línea de grupo re-enviada sin banderas (mismo grupo_extra_id, o mismo concepto y monto)', () => {
    const r = anclarExtrasDeGrupo(
      [tourGrupo],
      [
        { concepto: 'tour chichén itzá ', monto_usd: 765 },
        { concepto: 'Tour Chichén Itzá', cantidad: 9, unitario: 85 },
        {
          concepto: 'Otro nombre',
          monto_usd: 765,
          grupo_extra_id: tourGrupo.grupo_extra_id,
        },
        { concepto: 'Handler', monto_usd: 150 },
      ],
    )!;
    expect(r.map((e) => e.concepto)).toEqual(['Tour Chichén Itzá', 'Handler']);
  });

  it('mismo concepto con OTRO monto se conserva como línea propia (duplicado visible, no descarte silencioso)', () => {
    const r = anclarExtrasDeGrupo(
      [tourGrupo],
      [{ concepto: 'Tour Chichén Itzá', monto_usd: 85 }],
    )!;
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual(tourGrupo);
    expect(r[1]).toEqual({ concepto: 'Tour Chichén Itzá', monto_usd: 85 });
  });

  it('el front no puede BORRAR una línea de grupo omitiéndola', () => {
    const r = anclarExtrasDeGrupo([tourGrupo], [])!;
    expect(r).toEqual([tourGrupo]);
    // Omitir la lista completa conserva TODO lo persistido (grupo y propios).
    expect(anclarExtrasDeGrupo([tourGrupo, handler], undefined)).toEqual([
      tourGrupo,
      handler,
    ]);
  });
});

describe('mezclarExtrasDesdeGrupo (escritor = grupo)', () => {
  const tourViejo = {
    concepto: 'Tour Chichén Itzá',
    cantidad: 9,
    unitario: 85,
    monto_usd: 765,
    origen: 'GRUPO',
    grupo_extra_id: '11111111-0000-0000-0000-000000000001',
  };
  const tourNuevo = { ...tourViejo, cantidad: 10, monto_usd: 850 };
  const catering = { concepto: 'Catering', monto_usd: 120, origen: 'VUELO' };
  const legado = { concepto: 'Handler', monto_usd: 150 };

  it('las líneas del grupo reemplazan a las GRUPO persistidas y las propias del hijo sobreviven', () => {
    expect(
      mezclarExtrasDesdeGrupo([tourViejo, catering, legado], [tourNuevo]),
    ).toEqual([tourNuevo, catering, legado]);
  });

  it('sin entrantes solo quedan las propias; sin persistidos, solo las entrantes', () => {
    expect(mezclarExtrasDesdeGrupo([tourViejo, catering], undefined)).toEqual([
      catering,
    ]);
    expect(mezclarExtrasDesdeGrupo(null, [tourNuevo])).toEqual([tourNuevo]);
  });
});
