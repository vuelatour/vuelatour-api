import { puntosRutaVisible } from './ruta-visible.util';

describe('puntosRutaVisible', () => {
  const leg = (o: string, d: string) => ({ origen_iata: o, destino_iata: d });

  it('cadena continua: primer origen + destinos (igual que el walk clásico)', () => {
    expect(puntosRutaVisible([leg('CUN', 'CZM'), leg('CZM', 'CUN')])).toEqual([
      'CUN',
      'CZM',
      'CUN',
    ]);
  });

  it('hueco intermedio (tramos ocultos en medio): une los puntos que quedan', () => {
    // Visibles 1, 4 y 5 de un viaje de 5 tramos (caso del cliente).
    expect(
      puntosRutaVisible([
        leg('CUN', 'AZP'),
        leg('BZE', 'CZM'),
        leg('CZM', 'CUN'),
      ]),
    ).toEqual(['CUN', 'AZP', 'BZE', 'CZM', 'CUN']);
  });

  it('oculto también el primero: arranca donde arranca lo visible', () => {
    expect(puntosRutaVisible([leg('BZE', 'CZM'), leg('CZM', 'CUN')])).toEqual([
      'BZE',
      'CZM',
      'CUN',
    ]);
  });

  it('sobrevuelo (origen = destino) se conserva como CUN → CUN', () => {
    expect(puntosRutaVisible([leg('CUN', 'CUN')])).toEqual(['CUN', 'CUN']);
  });

  it('sin tramos: lista vacía (el caller degrada al origen→destino del vuelo)', () => {
    expect(puntosRutaVisible([])).toEqual([]);
  });
});
