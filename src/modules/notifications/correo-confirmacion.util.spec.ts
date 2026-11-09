import {
  armarCorreoConfirmacion,
  escaparHtml,
  fechaCorreoCliente,
  montoCorreoCliente,
} from './correo-confirmacion.util';

/**
 * Contenido del correo «Vuelo confirmado» al cliente (9-nov-2026, invariante
 * 128): PURO, compartido por la vista previa y el envío. Caso real: el
 * correo del folio #538 que la oficina reenvió por WhatsApp.
 */
const F538 = {
  clienteNombre: 'Palma',
  folio: 538,
  origenIata: 'CUN',
  destinoIata: 'CUN',
  pasajeros: 3,
  // 3 de enero de 2027, 8:00 a.m. en Cancún (UTC−5).
  fechaVuelo: '2027-01-03T13:00:00+00:00',
  montoTotalUsd: 2488.2,
};

describe('montoCorreoCliente', () => {
  it('SIEMPRE dos decimales (el #538 decía «$2,488.2 USD»)', () => {
    expect(montoCorreoCliente(2488.2)).toBe('$2,488.20 USD');
    expect(montoCorreoCliente(1500)).toBe('$1,500.00 USD');
    expect(montoCorreoCliente(0)).toBe('$0.00 USD');
    expect(montoCorreoCliente(Number.NaN)).toBe('$0.00 USD');
  });
});

describe('fechaCorreoCliente', () => {
  it('fecha larga en HORA CANCÚN, o «Por confirmar»', () => {
    const f = fechaCorreoCliente(F538.fechaVuelo);
    expect(f).toContain('3 de enero de 2027');
    expect(f).toContain('8:00');
    expect(f.endsWith('(hora de Cancún)')).toBe(true);
    expect(fechaCorreoCliente(null)).toBe('Por confirmar');
    expect(fechaCorreoCliente('no-es-fecha')).toBe('Por confirmar');
  });
});

describe('armarCorreoConfirmacion', () => {
  it('asunto, HTML y texto del folio #538 con el monto corregido', () => {
    const c = armarCorreoConfirmacion(F538);
    expect(c.asunto).toBe('Vuelo confirmado · CUN → CUN (folio #538)');
    expect(c.html).toContain('Hola <strong>Palma</strong>');
    expect(c.html).toContain('CONFIRMADO');
    expect(c.html).toContain('#538');
    expect(c.html).toContain('$2,488.20 USD');
    expect(c.html).not.toContain('$2,488.2 USD');
    expect(c.texto).toContain('Hola Palma,');
    expect(c.texto).toContain('Folio: #538');
    expect(c.texto).toContain('Pasajeros: 3');
    expect(c.texto).toContain('Monto total: $2,488.20 USD');
  });

  it('es determinista: dos llamadas con los mismos datos dan el MISMO contenido (vista previa == envío)', () => {
    expect(armarCorreoConfirmacion(F538)).toEqual(
      armarCorreoConfirmacion(F538),
    );
  });

  it('un nombre con HTML no rompe el correo; sin nombre ⇒ «Cliente»', () => {
    const c = armarCorreoConfirmacion({
      ...F538,
      clienteNombre: 'Tours <b>&</b> "Co"',
    });
    expect(c.html).toContain('Tours &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;');
    expect(c.html).not.toContain('<b>&</b>');
    // El texto plano no se escapa.
    expect(c.texto).toContain('Hola Tours <b>&</b> "Co",');
    expect(
      armarCorreoConfirmacion({ ...F538, clienteNombre: '  ' }).texto,
    ).toContain('Hola Cliente,');
    expect(escaparHtml('a<b>&"')).toBe('a&lt;b&gt;&amp;&quot;');
  });
});
