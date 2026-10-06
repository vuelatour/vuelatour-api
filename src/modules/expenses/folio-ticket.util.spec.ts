import {
  FOLIO_CANDADO_MIN,
  FOLIO_TICKET_MAX,
  folioConCandado,
  folioTicketDeLectura,
  normalizarFolio,
  esFolioDeRelleno,
} from './folio-ticket.util';

/** Folio del comprobante: la MISMA regla en la captura y en el cron. */
describe('folio-ticket.util', () => {
  it('normalizarFolio = la columna generada folio_ticket_norm', () => {
    expect(normalizarFolio('FEACZM-72128')).toBe('FEACZM72128');
    expect(normalizarFolio(' a-0411 ')).toBe('A0411');
    expect(normalizarFolio('---')).toBeNull();
    expect(normalizarFolio(null)).toBeNull();
    expect(normalizarFolio(undefined)).toBeNull();
  });

  it('folioTicketDeLectura: recorta, 60 caracteres, número ⇒ texto', () => {
    expect(folioTicketDeLectura('  A-0411  ')).toBe('A-0411');
    expect(folioTicketDeLectura(72128)).toBe('72128');
    // «AB» repetido: largo real sin caer en la regla de folio de relleno.
    const largo = 'AB'.repeat(40);
    expect(folioTicketDeLectura(largo)).toBe('AB'.repeat(FOLIO_TICKET_MAX / 2));
    expect(FOLIO_TICKET_MAX).toBe(60);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['   '],
    ['—'],
    ['S/N'],
    ['s/n'],
    ['N/A'],
    ['n.d.'],
    ['Sin folio'],
    ['NULL'],
    [Number.NaN],
    [{ folio: 'A-1' }],
  ])('sin folio utilizable: %p ⇒ null', (raw) => {
    expect(folioTicketDeLectura(raw)).toBeNull();
  });

  it('un folio que solo CONTIENE «SN» no se descarta', () => {
    expect(folioTicketDeLectura('SN-1234')).toBe('SN-1234');
    expect(folioTicketDeLectura('NA7')).toBe('NA7');
  });

  it('folioConCandado = el predicado del índice único (≥ 4 alfanuméricos)', () => {
    expect(FOLIO_CANDADO_MIN).toBe(4);
    expect(folioConCandado('A-12')).toBe(false);
    expect(folioConCandado('A-123')).toBe(true);
    expect(folioConCandado(null)).toBe(false);
  });

  it('folio de RELLENO (12345, 0000, XXXX) ⇒ null; uno real que lo contenga se conserva', () => {
    for (const x of [
      '12345',
      '1234',
      '123',
      '1234567890',
      '12-345',
      '0000',
      '1111',
      'XXX',
      'xxxx',
    ]) {
      expect(folioTicketDeLectura(x)).toBeNull();
    }
    for (const x of [
      'A12345',
      '123456X',
      '52259186008',
      '12',
      'FEACZM 72048',
      '10000',
      '2345',
    ]) {
      expect(folioTicketDeLectura(x)).toBe(x);
    }
    expect(esFolioDeRelleno('12345')).toBe(true);
    expect(esFolioDeRelleno('12')).toBe(false);
    expect(esFolioDeRelleno('AA')).toBe(false);
    expect(esFolioDeRelleno('AAA')).toBe(true);
    expect(esFolioDeRelleno('12346')).toBe(false);
  });
});
