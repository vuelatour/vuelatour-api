import {
  FLECHA_CUENTA_COBRO,
  PREFIJO_COMISION_BANCO_COBRO,
  PREFIJO_REGISTRO_COBRO,
  SEPARADOR_COBRADO_CON,
  etiquetaCobradoCon,
  textoComisionCobro,
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

/**
 * COMISIÓN BANCARIA EN LA NOTA (6-oct-2026, API 0.0.65): en los vuelos de la
 * vigencia de `comisiones-avion.util` la celda «COBRO n» muestra el NETO y
 * su nota EMPIEZA con bruto · comisión · neto (caso real #235: Transferencia
 * de $20,400.00 con 5 % de comisión).
 */
describe('etiquetaCobradoCon — comisión bancaria (API 0.0.65)', () => {
  const c235 = {
    bruto_mxn: 20400,
    comision_mxn: 1020,
    pct: 5,
    neto_mxn: 19380,
  };

  it('caso del contrato: bruto · comisión · neto y después cómo se cobró', () => {
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: 'Transferencia',
        cuenta: 'Scotiabank Pesos',
        registro: 'Itzi',
        comision: c235,
      }),
    ).toBe(
      'Bruto $20,400.00 · comisión banco 5 % $1,020.00 · neto $19,380.00 · Transferencia → Scotiabank Pesos · Registró: Itzi',
    );
  });

  it('sin % capturado: solo el monto de la comisión', () => {
    expect(textoComisionCobro({ ...c235, pct: null })).toBe(
      'Bruto $20,400.00 · comisión banco $1,020.00 · neto $19,380.00',
    );
    expect(textoComisionCobro({ ...c235, pct: 3.828 })).toBe(
      'Bruto $20,400.00 · comisión banco 3.83 % $1,020.00 · neto $19,380.00',
    );
  });

  it('sin método, cuenta ni registro: la comisión sí dice algo (no es null); la parte va al final', () => {
    const parte = 'parte de esta fila (50 % de la venta del avión)';
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: null,
        cuenta: null,
        registro: null,
        comision: c235,
        parte,
      }),
    ).toBe(
      `Bruto $20,400.00 · comisión banco 5 % $1,020.00 · neto $19,380.00 · ${parte}`,
    );
  });

  it('comisión en 0 o ausente: la línea de siempre, byte a byte', () => {
    const base = {
      metodo_etiqueta: 'Efectivo',
      cuenta: null,
      registro: 'Itzi',
    };
    expect(etiquetaCobradoCon({ ...base, comision: null })).toBe(
      etiquetaCobradoCon(base),
    );
    expect(
      etiquetaCobradoCon({
        ...base,
        comision: { ...c235, comision_mxn: 0, neto_mxn: 20400 },
      }),
    ).toBe('Efectivo · Registró: Itzi');
    expect(
      etiquetaCobradoCon({
        metodo_etiqueta: null,
        cuenta: null,
        registro: null,
        comision: { ...c235, comision_mxn: 0 },
      }),
    ).toBeNull();
  });

  it('el prefijo es el del contrato', () => {
    expect(PREFIJO_COMISION_BANCO_COBRO).toBe('comisión banco ');
  });
});
