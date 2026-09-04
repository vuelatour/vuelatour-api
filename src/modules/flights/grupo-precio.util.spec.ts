import { marcarPrecioDesactualizado } from './grupo-precio.util';

const KODIAK = 'aaaaaaaa-0000-0000-0000-000000000001';
const C182 = 'bbbbbbbb-0000-0000-0000-000000000002';

const snapshotHijo = {
  aeronave: { id: KODIAK, matricula: 'N621TX' },
  totales: { total_usd: 4120.32 },
  desglose: [{ clave: 'TIEMPO_VUELO', monto_usd: 2625 }],
  meta: {
    version_motor: '1.3.1',
    grupo: { id: 'g-1', folio: 12, posicion: 1, total_aviones: 7, pax: 9 },
  },
};

describe('marcarPrecioDesactualizado', () => {
  it('cambio de avión en un hijo de grupo: prende la bandera SIN tocar dinero', () => {
    const r = marcarPrecioDesactualizado(snapshotHijo, C182);
    expect(r.cambio).toBe(true);
    const meta = r.snapshot.meta as { grupo: Record<string, unknown> };
    expect(meta.grupo.precio_desactualizado).toBe(true);
    expect(meta.grupo).toMatchObject({ id: 'g-1', posicion: 1, pax: 9 });
    expect(r.snapshot.totales).toEqual(snapshotHijo.totales);
    expect(r.snapshot.desglose).toEqual(snapshotHijo.desglose);
    expect(r.snapshot.aeronave).toEqual(snapshotHijo.aeronave);
    // El original no se muta.
    expect(snapshotHijo.meta.grupo).not.toHaveProperty('precio_desactualizado');
  });

  it('mismo avión que el cotizado: sin cambio; volver al cotizado la apaga', () => {
    expect(marcarPrecioDesactualizado(snapshotHijo, KODIAK).cambio).toBe(false);
    const prendida = marcarPrecioDesactualizado(snapshotHijo, C182).snapshot;
    const r = marcarPrecioDesactualizado(prendida, KODIAK);
    expect(r.cambio).toBe(true);
    expect(
      (r.snapshot.meta as { grupo: Record<string, unknown> }).grupo
        .precio_desactualizado,
    ).toBe(false);
  });

  it('sin meta.grupo (vuelo normal) o sin avión cotizado: nunca escribe', () => {
    expect(
      marcarPrecioDesactualizado({ aeronave: { id: KODIAK }, meta: {} }, C182)
        .cambio,
    ).toBe(false);
    expect(
      marcarPrecioDesactualizado(
        { meta: { grupo: { id: 'g-1' } } }, // reserva sin precio
        C182,
      ).cambio,
    ).toBe(false);
    expect(marcarPrecioDesactualizado(null, C182).cambio).toBe(false);
    expect(marcarPrecioDesactualizado(snapshotHijo, null).cambio).toBe(false);
  });
});
