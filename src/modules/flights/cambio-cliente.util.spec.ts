import { HttpException } from '@nestjs/common';
import {
  avisosCambioCliente,
  CODE_CLIENTE_INACTIVO,
  CODE_CLIENTE_NO_EXISTE,
  CODE_VUELO_DE_GRUPO,
  CODE_VUELO_FACTURADO,
  errorCambioClienteDeGrupo,
  errorClienteInactivo,
  errorClienteNoExiste,
  errorVueloFacturado,
  selloCambioCliente,
  type EntradaAvisosCambioCliente,
} from './cambio-cliente.util';

/**
 * Cambiar el cliente de un vuelo que ya existe (27-nov-2026): textos y
 * avisos PUROS. El precio no se mueve; cada aviso dice qué cambia con el
 * cliente nuevo.
 */
const cuerpo = (e: HttpException) =>
  e.getResponse() as {
    message: string;
    error: string;
    details: Record<string, unknown>;
  };

const cliente = (
  nombre: string,
  extra: Partial<{ es_interno: boolean; es_broker: boolean }> = {},
) => ({ nombre, es_interno: false, es_broker: false, ...extra });

function entrada(
  extra: Partial<EntradaAvisosCambioCliente> = {},
): EntradaAvisosCambioCliente {
  return {
    anterior: cliente('Beh Kay'),
    nuevo: cliente('January Davila'),
    nuevo_tarifa_preferencial: null,
    cotizado: true,
    tarifa_persistida: 650,
    tarifa_personalizada: false,
    tarifa_preferencial_aplicada: false,
    tarifa_tipo: 'PUBLICO',
    monto_total_usd: 1624,
    cobros: 0,
    cobros_de_anticipo: 0,
    solicitud_factura: false,
    ...extra,
  };
}

describe('cambio de cliente — rechazos con code estable', () => {
  it('cliente que no existe ⇒ 404 CLIENTE_NO_EXISTE', () => {
    const e = errorClienteNoExiste('c-1');
    expect(e.getStatus()).toBe(404);
    expect(cuerpo(e).error).toBe(CODE_CLIENTE_NO_EXISTE);
    expect(cuerpo(e).details).toEqual({ cliente_id: 'c-1' });
  });

  it('cliente dado de baja ⇒ 400 CLIENTE_INACTIVO con su nombre', () => {
    const e = errorClienteInactivo({ id: 'c-1', nombre: 'Beh Kay' });
    expect(e.getStatus()).toBe(400);
    expect(cuerpo(e).error).toBe(CODE_CLIENTE_INACTIVO);
    expect(cuerpo(e).message).toBe(
      'Beh Kay está dado de baja: reactívalo en Clientes o elige otro.',
    );
  });

  it('CFDI timbrado ⇒ 409 VUELO_FACTURADO y dice qué hacer', () => {
    const e = errorVueloFacturado({ folio: 341, motivo: 'CFDI' });
    expect(e.getStatus()).toBe(409);
    expect(cuerpo(e).error).toBe(CODE_VUELO_FACTURADO);
    expect(cuerpo(e).message).toBe(
      'El vuelo #341 ya tiene CFDI emitida a nombre de su cliente: cancela la factura antes de cambiar el cliente.',
    );
    expect(cuerpo(e).details).toEqual({ motivo: 'CFDI' });
  });

  it('factura emitida VIGENTE ligada ⇒ nombra la(s) factura(s)', () => {
    const una = errorVueloFacturado({
      folio: 375,
      motivo: 'FACTURA_EMITIDA',
      facturas: ['A-0440'],
    });
    expect(cuerpo(una).message).toBe(
      'El vuelo #375 tiene la factura A-0440 registrada a nombre de su cliente: cancélala o desliga el vuelo en Facturas emitidas antes de cambiar el cliente.',
    );
    expect(cuerpo(una).details).toEqual({
      motivo: 'FACTURA_EMITIDA',
      facturas: ['A-0440'],
    });
    const dos = errorVueloFacturado({
      folio: 375,
      motivo: 'FACTURA_EMITIDA',
      facturas: ['A-0440', 'A-0441'],
    });
    expect(cuerpo(dos).message).toContain(
      'las facturas A-0440 y A-0441 registradas',
    );
  });

  it('estatus MANUAL de factura ⇒ dice el estatus y cómo destrabar', () => {
    const e = errorVueloFacturado({
      folio: 376,
      motivo: 'ESTATUS_MANUAL',
      estatus: 'Facturado',
    });
    expect(cuerpo(e).error).toBe(CODE_VUELO_FACTURADO);
    expect(cuerpo(e).message).toContain('marcada como «Facturado»');
    expect(cuerpo(e).message).toContain('Regresa el estatus a «Sin factura»');
  });

  it('hijo de grupo ⇒ 409 VUELO_DE_GRUPO con el folio del grupo', () => {
    const e = errorCambioClienteDeGrupo({
      folio: 410,
      grupoId: 'g-1',
      grupoFolio: 12,
    });
    expect(e.getStatus()).toBe(409);
    expect(cuerpo(e).error).toBe(CODE_VUELO_DE_GRUPO);
    expect(cuerpo(e).message).toBe(
      'El vuelo #410 es parte de la cotización de grupo G-12: el cliente es el del grupo completo y no se cambia avión por avión.',
    );
    expect(cuerpo(e).details).toEqual({ grupo_id: 'g-1', grupo_folio: 12 });
  });
});

describe('cambio de cliente — sello de notas internas', () => {
  it('quién, cuándo y de qué cliente a cuál', () => {
    expect(
      selloCambioCliente({
        fecha: '27/11/2026 12:05',
        quien: 'Itzi',
        anterior: 'Beh Kay',
        nuevo: 'January Davila',
      }),
    ).toBe(
      '[Cliente cambiado el 27/11/2026 12:05 por Itzi: «Beh Kay» → «January Davila»]',
    );
  });

  it('sin nombre de usuario ni cliente anterior no inventa nada', () => {
    expect(
      selloCambioCliente({
        fecha: '27/11/2026 12:05',
        quien: null,
        anterior: null,
        nuevo: 'January Davila',
      }),
    ).toBe(
      '[Cliente cambiado el 27/11/2026 12:05: «sin cliente» → «January Davila»]',
    );
  });
});

describe('cambio de cliente — avisos (el precio NO cambió)', () => {
  it('sin nada que avisar ⇒ []', () => {
    expect(avisosCambioCliente(entrada())).toEqual([]);
  });

  it('el nuevo tiene tarifa preferencial distinta y la tarifa era de lista ⇒ la próxima versión la aplica', () => {
    const a = avisosCambioCliente(entrada({ nuevo_tarifa_preferencial: 600 }));
    expect(a).toEqual([
      'January Davila tiene tarifa preferencial de $600/hr en este avión y la cotización conserva $650/hr: el precio NO cambió. La próxima versión que se guarde de la cotización se cotizará con $600/hr.',
    ]);
  });

  it('con tarifa PERSONALIZADA la preferencial no entra sola: se dice cómo aplicarla', () => {
    const a = avisosCambioCliente(
      entrada({
        nuevo_tarifa_preferencial: 600,
        tarifa_personalizada: true,
        tarifa_persistida: 989.583333,
      }),
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('conserva $989.58/hr (tarifa personalizada)');
    expect(a[0]).toContain(
      'Si quieres aplicarle la preferencial, cámbiala en la cotización y guarda una versión.',
    );
    expect(a[0]).not.toContain('La próxima versión');
  });

  it('la preferencial del nuevo es la MISMA que la persistida ⇒ sin aviso', () => {
    expect(
      avisosCambioCliente(
        entrada({ nuevo_tarifa_preferencial: 650, tarifa_persistida: 650 }),
      ),
    ).toEqual([]);
  });

  it('la cotización usaba la preferencial del anterior y el nuevo no tiene ⇒ volverá a la de lista', () => {
    const a = avisosCambioCliente(
      entrada({ tarifa_preferencial_aplicada: true, tarifa_persistida: 600 }),
    );
    expect(a).toEqual([
      'La cotización se pactó con la tarifa preferencial de Beh Kay ($600/hr) y January Davila no tiene una en este avión: el precio NO cambió. La próxima versión que se guarde de la cotización se cotizará con la tarifa de lista del avión.',
    ]);
  });

  it('nuevo BROKER con tarifa PÚBLICA de lista ⇒ aviso; con tarifa personalizada, no', () => {
    const broker = cliente('Riviera Jets', { es_broker: true });
    expect(avisosCambioCliente(entrada({ nuevo: broker }))).toEqual([
      'Riviera Jets es broker y la cotización está con tarifa PÚBLICA: el precio NO cambió. Si le corresponde la tarifa de broker, cámbiala en la cotización y guarda una versión.',
    ]);
    expect(
      avisosCambioCliente(
        entrada({ nuevo: broker, tarifa_personalizada: true }),
      ),
    ).toEqual([]);
  });

  it('nuevo NO broker con tarifa de BROKER ⇒ aviso', () => {
    const a = avisosCambioCliente(entrada({ tarifa_tipo: 'BROKER' }));
    expect(a).toHaveLength(1);
    expect(a[0]).toContain(
      'no es broker y la cotización está con tarifa de BROKER',
    );
  });

  it('a un cliente INTERNO: deja de ser cuenta por cobrar y conserva el total', () => {
    const a = avisosCambioCliente(
      entrada({
        nuevo: cliente('Vuelos de reposicionamiento', { es_interno: true }),
        // Aunque tuviera preferencial o fuera broker, manda el aviso de interno.
        nuevo_tarifa_preferencial: 500,
      }),
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('es un cliente INTERNO (operación propia)');
    expect(a[0]).toContain('conserva su total de $1,624 USD');
  });

  it('de un cliente INTERNO a uno normal: hay que revisar la cotización para cobrar', () => {
    const a = avisosCambioCliente(
      entrada({
        anterior: cliente('Servicio', { es_interno: true }),
        monto_total_usd: 0,
      }),
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toContain(
      'Servicio es un cliente INTERNO y January Davila no',
    );
    expect(a[0]).toContain('conserva su total de $0 USD');
    expect(a[0]).toContain('revísala y guarda una versión para cobrarle');
  });

  it('sin cotización (reserva sin precio) no se habla de tarifas', () => {
    expect(
      avisosCambioCliente(
        entrada({
          cotizado: false,
          nuevo_tarifa_preferencial: 600,
          nuevo: cliente('Riviera Jets', { es_broker: true }),
        }),
      ),
    ).toEqual([]);
  });

  it('cobros: se conservan y el recibo sale a nombre del nuevo (singular/plural)', () => {
    expect(avisosCambioCliente(entrada({ cobros: 1 }))).toEqual([
      'El vuelo tiene 1 cobro registrado: se conserva tal cual y su recibo saldrá a nombre de January Davila.',
    ]);
    expect(avisosCambioCliente(entrada({ cobros: 3 }))).toEqual([
      'El vuelo tiene 3 cobros registrados: se conservan tal cual y sus recibos saldrán a nombre de January Davila.',
    ]);
  });

  it('cobros de anticipo y «Necesito factura» se avisan aparte, en orden', () => {
    const a = avisosCambioCliente(
      entrada({
        nuevo_tarifa_preferencial: 600,
        cobros: 2,
        cobros_de_anticipo: 1,
        solicitud_factura: true,
      }),
    );
    expect(a).toHaveLength(4);
    expect(a[0]).toContain('tarifa preferencial');
    expect(a[1]).toContain('2 cobros registrados');
    expect(a[2]).toBe(
      '1 de esos cobros viene de un anticipo (Ingresos) registrado a nombre de un cliente: revisa que siga correspondiendo.',
    );
    expect(a[3]).toBe(
      'El vuelo tiene «Necesito factura»: se facturará con los datos fiscales de January Davila; revisa que estén completos en Clientes.',
    );
  });

  it('ningún aviso dice que el precio cambió', () => {
    const todos = [
      ...avisosCambioCliente(entrada({ nuevo_tarifa_preferencial: 600 })),
      ...avisosCambioCliente(entrada({ tarifa_preferencial_aplicada: true })),
      ...avisosCambioCliente(entrada({ tarifa_tipo: 'BROKER' })),
    ];
    for (const t of todos) expect(t).toContain('el precio NO cambió');
  });
});
