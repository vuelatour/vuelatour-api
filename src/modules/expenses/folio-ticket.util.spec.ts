import {
  FOLIO_CANDADO_MIN,
  FOLIO_TICKET_MAX,
  folioConCandado,
  folioTicketDeLectura,
  normalizarFolio,
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
    const largo = 'X'.repeat(80);
    expect(folioTicketDeLectura(largo)).toBe('X'.repeat(FOLIO_TICKET_MAX));
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
});
