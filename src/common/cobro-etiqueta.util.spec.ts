import {
  FLECHA_CUENTA_COBRO,
  PREFIJO_REGISTRO_COBRO,
  SEPARADOR_COBRADO_CON,
  etiquetaCobradoCon,
} from './cobro-etiqueta.util';
import { etiquetaMetodoCobro } from './metodo-cobro.util';

/**
 * «Cómo se cobró» cada parcialidad (6-oct-2026, API 0.0.60). Los textos son
 * contrato: pyservices los pinta TAL CUAL en la nota de la celda «COBRO n»
 * del balance, y repiten la forma que el panel ya pinta por cobro
 * («Transferencia → Scotiabank Pesos · Registró: Itzi»). Los casos usan
 * combinaciones REALES de prod (6-oct: Itzi, Alejandro Canales y Pablo
 * Canales; Scotiabank Pesos, HSBC Dólares, Paywise; efectivo y dólares sin
 * cuenta).
 */
describe('etiquetaCobradoCon (fuente única de `cobrado_con`)', () => {
  it('cobro completo: método → cuenta · Registró: nombre', () => {
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: etiquetaMetodoCobro('TRANSFERENCIA'),
        cuenta: 'Scotiabank Pesos',
        registro: 'Itzi',
      }),
    ).toBe('Transferencia → Scotiabank Pesos · Registró: Itzi');
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: etiquetaMetodoCobro('PAYWISE'),
        cuenta: 'Paywise',
        registro: 'Pablo Canales',
      }),
    ).toBe('Link de pago (Paywise) → Paywise · Registró: Pablo Canales');
  });

  it('sin cuenta (efectivo, dólares directo): sin flecha', () => {
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: etiquetaMetodoCobro('EFECTIVO'),
        cuenta: null,
        registro: 'Itzi',
      }),
    ).toBe('Efectivo · Registró: Itzi');
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: etiquetaMetodoCobro('DOLARES'),
        cuenta: '   ',
        registro: 'Alejandro Canales',
      }),
    ).toBe('Dólares directo · Registró: Alejandro Canales');
  });

  it('sin registro (usuario borrado o sin dato): método → cuenta, sin «Registró»', () => {
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: 'Transferencia',
        cuenta: 'Scotiabank Pesos',
        registro: null,
      }),
    ).toBe('Transferencia → Scotiabank Pesos');
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: 'Efectivo',
        cuenta: undefined,
        registro: '  ',
      }),
    ).toBe('Efectivo');
  });

  it('multi-avión: la parte de la fila va AL FINAL (la flecha queda pegada al método)', () => {
    const parte =
      'parte de esta fila (50 % de la venta del avión + ingreso VuelaTour)';
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: 'Transferencia',
        cuenta: 'HSBC Dólares',
        registro: 'Itzi',
        parte,
      }),
    ).toBe(`Transferencia → HSBC Dólares · Registró: Itzi · ${parte}`);
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: 'Efectivo',
        cuenta: null,
        registro: null,
        parte,
      }),
    ).toBe(`Efectivo · ${parte}`);
  });

  it('sin método, cuenta ni registro ⇒ null (la parte sola no dice cómo se cobró)', () => {
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: null,
        cuenta: null,
        registro: null,
      }),
    ).toBeNull();
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: '—',
        cuenta: '',
        registro: undefined,
        parte: 'parte de esta fila (50 % de la venta del avión)',
      }),
    ).toBeNull();
  });

  it('sin método pero con cuenta o registro: lo que haya («—» de `etiquetaMetodoCobro(null)` = sin método)', () => {
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: etiquetaMetodoCobro(null),
        cuenta: 'Scotiabank Pesos',
        registro: 'Itzi',
      }),
    ).toBe('→ Scotiabank Pesos · Registró: Itzi');
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: null,
        cuenta: null,
        registro: 'Itzi',
      }),
    ).toBe('Registró: Itzi');
  });

  it('recorta y colapsa espacios; jamás un uuid como nombre', () => {
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: '  Transferencia ',
        cuenta: ' Scotiabank   Pesos ',
        registro: '  Pablo   Canales ',
      }),
    ).toBe('Transferencia → Scotiabank Pesos · Registró: Pablo Canales');
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: 'Transferencia',
        cuenta: 'Scotiabank Pesos',
        registro: 'c691cc8b-1234-4abc-9def-0123456789ab',
      }),
    ).toBe('Transferencia → Scotiabank Pesos');
  });

  it('los separadores son los del panel', () => {
    expect(FLECHA_CUENTA_COBRO).toBe(' → ');
    expect(SEPARADOR_COBRADO_CON).toBe(' · ');
    expect(PREFIJO_REGISTRO_COBRO).toBe('Registró: ');
  });
});
