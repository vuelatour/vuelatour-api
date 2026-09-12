import {
  avionesDeTramos,
  avionesUtilizados,
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

  it('#298: con tramos en aviones distintos el cliente SIGUE viendo solo el modelo COTIZADO', () => {
    // Regla 12-sep-2026: la cotización es independiente de la operación —
    // reasignar tramos a otros aviones no cambia la hoja del cliente. Antes
    // esta misma entrada imprimía ['Kodiak 100', 'Piper Meridian'] (dato
    // OPERATIVO colándose a la cotización).
    const v = { aeronave_id: 'anu', calculo_snapshot: snap };
    const escalas = [
      { aeronave_id: null, cancelada_at: null },
      { aeronave_id: 'meridian', cancelada_at: null },
      { aeronave_id: 'anu2', cancelada_at: null },
      { aeronave_id: 'seneca', cancelada_at: '2026-09-01T00:00:00Z' },
      { aeronave_id: 'seneca', cancelada_at: null, es_ferry: true },
    ];
    // El dato operativo sigue disponible (control interno), pero no se pinta.
    expect(avionesDeTramos(v, escalas)).toEqual(['anu', 'meridian', 'anu2']);
    expect(modelosCotizados(v, escalas, modelos)).toEqual(['Seneca V']);
  });

  it('#298: el vuelo entero reasignado a otro avión no mueve el modelo cotizado', () => {
    const v = { aeronave_id: 'meridian', calculo_snapshot: snap };
    const escalas = [{ aeronave_id: 'meridian', cancelada_at: null }];
    expect(modelosCotizados(v, escalas, modelos)).toEqual(['Seneca V']);
  });

  it('RESPALDO sin snapshot: los modelos de los tramos (y con uno solo, ese)', () => {
    const v = { aeronave_id: 'anu', calculo_snapshot: null };
    const escalas = [
      { aeronave_id: null, cancelada_at: null },
      { aeronave_id: 'meridian', cancelada_at: null },
    ];
    expect(modelosCotizados(v, escalas, modelos)).toEqual([
      'Kodiak 100',
      'Piper Meridian',
    ]);
    expect(
      modelosCotizados(
        { aeronave_id: 'anu', calculo_snapshot: null },
        [],
        modelos,
      ),
    ).toEqual(['Kodiak 100']);
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

/**
 * «Aeronave cotizada» vs «aeronave utilizada» (control interno, 11-sep-2026):
 * el cliente ve el modelo COTIZADO; la oficina necesita además qué avión lo
 * está volando de verdad.
 */
describe('avionesUtilizados (avión que vuela HOY el itinerario)', () => {
  it('tramos vivos con herencia, en orden y sin repetir; ferry y solo-operativa CUENTAN', () => {
    const v = { aeronave_id: 'anu' };
    const escalas = [
      { aeronave_id: null, cancelada_at: null },
      { aeronave_id: 'meridian', cancelada_at: null, es_ferry: true },
      { aeronave_id: 'anu', cancelada_at: null, solo_operativa: true },
      { aeronave_id: 'seneca', cancelada_at: '2026-09-01T00:00:00Z' },
    ];
    expect(avionesUtilizados(v, escalas)).toEqual(['anu', 'meridian']);
  });

  it('sin tramos vivos: el avión del vuelo; sin avión ⇒ []', () => {
    expect(avionesUtilizados({ aeronave_id: 'anu' }, [])).toEqual(['anu']);
    expect(
      avionesUtilizados({ aeronave_id: 'anu' }, [
        { aeronave_id: 'anu', cancelada_at: '2026-09-01T00:00:00Z' },
      ]),
    ).toEqual(['anu']);
    expect(avionesUtilizados({ aeronave_id: null }, [])).toEqual([]);
  });

  it('difiere del COTIZADO cuando la operación cambió de avión (caso #254)', () => {
    const v = {
      aeronave_id: 'anu',
      calculo_snapshot: { aeronave: { id: 'seneca', modelo: 'Seneca V' } },
    };
    const escalas = [{ aeronave_id: null, cancelada_at: null }];
    expect(modeloCotizadoDe(v)).toBe('Seneca V');
    expect(avionesUtilizados(v, escalas)).toEqual(['anu']);
  });
});
