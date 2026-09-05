import {
  avionesDeTramos,
  modeloCotizadoDe,
  modelosCotizados,
} from './modelos-cotizados.util';

describe('modelosCotizados (modelo del avión cotizado, nunca matrícula)', () => {
  const modelos = new Map<string, string | null>([
    ['seneca', 'Seneca V'],
    ['anu', 'Kodiak 100'],
    ['anu2', 'Kodiak 100'],
    ['meridian', 'Piper Meridian'],
  ]);
  const snap = { aeronave: { id: 'seneca', modelo: 'Seneca V' } };

  it('cotizado en Seneca y operado en Kodiak: un solo avión ⇒ el modelo del SNAPSHOT', () => {
    const v = { aeronave_id: 'anu', calculo_snapshot: snap };
    const escalas = [
      { aeronave_id: null, cancelada_at: null },
      { aeronave_id: 'anu', cancelada_at: null },
    ];
    expect(modeloCotizadoDe(v)).toBe('Seneca V');
    expect(avionesDeTramos(v, escalas)).toEqual(['anu']);
    expect(modelosCotizados(v, escalas, modelos)).toEqual(['Seneca V']);
  });

  it('tramos en aviones distintos ⇒ modelos distintos en orden de tramo, sin repetir', () => {
    const v = { aeronave_id: 'anu', calculo_snapshot: snap };
    const escalas = [
      { aeronave_id: null, cancelada_at: null },
      { aeronave_id: 'meridian', cancelada_at: null },
      { aeronave_id: 'anu2', cancelada_at: null },
      { aeronave_id: 'seneca', cancelada_at: '2026-09-01T00:00:00Z' },
      { aeronave_id: 'seneca', cancelada_at: null, es_ferry: true },
    ];
    expect(avionesDeTramos(v, escalas)).toEqual(['anu', 'meridian', 'anu2']);
    expect(modelosCotizados(v, escalas, modelos)).toEqual([
      'Kodiak 100',
      'Piper Meridian',
    ]);
  });

  it('externo: solo el modelo del avión ajeno (la referencia del snapshot no se muestra)', () => {
    const v = {
      aeronave_id: null,
      es_externo: true,
      avion_externo_modelo: ' Hawker 400 ',
      calculo_snapshot: snap,
    };
    expect(modelosCotizados(v, [], modelos)).toEqual(['Hawker 400']);
    expect(
      modelosCotizados({ ...v, avion_externo_modelo: null }, [], modelos),
    ).toEqual([]);
  });

  it('sin snapshot cae al modelo del avión del vuelo; sin nada ⇒ []', () => {
    expect(modelosCotizados({ aeronave_id: 'meridian' }, [], modelos)).toEqual([
      'Piper Meridian',
    ]);
    expect(modelosCotizados({ aeronave_id: null }, [], modelos)).toEqual([]);
  });
});
