import {
  bloqueFacturaServicio,
  elegirDestinatarios,
  esMarcadoSinRegistro,
  esPorFacturar,
  estadoSolicitud,
  fechaDiaMes,
  LIMITE_NOTA_SOLICITUD,
  notaSolicitudAutomatica,
  PREFIJO_NOTA_SOLICITUD_AUTOMATICA,
  resumenFacturaServicio,
  textoAvisoEmitida,
  textoAvisoSolicitud,
  type FacturaLigadaRow,
} from './factura-solicitud.util';

/**
 * «Necesito factura» (pedido de Itzi, 24-sep-2026): «por facturar» es
 * DERIVADO con UNA definición, los destinatarios se eligen por nivel y los
 * textos del aviso no dicen «Total $0 USD».
 */
const SOLICITADA = {
  estado: 'CONFIRMADO',
  facturado: false,
  factura_solicitada_at: '2026-09-24T15:00:00Z',
  factura_solicitada_por: 'u-itzi',
  factura_solicitud_nota: 'Lo necesita para pagar',
  factura_paga_contra_factura: true,
};

const ligada = (
  id: string,
  estatus: string,
  extra: Partial<FacturaLigadaRow> = {},
): FacturaLigadaRow => ({
  id,
  serie: 'A',
  folio: id,
  folio_num: Number(id),
  uuid: null,
  fecha_emision: '2026-09-24',
  estatus,
  total: '8050.40',
  moneda: 'USD',
  metodo_pago: 'PPD',
  pdf_path: `emitidas/${id}/x.pdf`,
  xml_path: null,
  deleted_at: null,
  ...extra,
});

describe('esPorFacturar (definición ÚNICA §3.8)', () => {
  it('solicitada, no cancelado, sin CFDI y sin vigentes ⇒ por facturar', () => {
    expect(esPorFacturar(SOLICITADA, 0)).toBe(true);
  });
  it('una vigente ligada lo saca', () => {
    expect(esPorFacturar(SOLICITADA, 1)).toBe(false);
  });
  it('CANCELADO, CFDI del PAC o sin solicitud ⇒ no', () => {
    expect(esPorFacturar({ ...SOLICITADA, estado: 'CANCELADO' }, 0)).toBe(
      false,
    );
    expect(esPorFacturar({ ...SOLICITADA, facturado: true }, 0)).toBe(false);
    expect(
      esPorFacturar({ ...SOLICITADA, factura_solicitada_at: null }, 0),
    ).toBe(false);
    expect(esPorFacturar(null, 0)).toBe(false);
  });

  // Caso #376 (13-oct-2026, invariante 65): el estatus MANUAL «Facturado»
  // saca al vuelo de la bandeja y lo manda a la nota «marcados sin registro».
  it('FACTURADO a mano sin vigentes ⇒ MARCADO_SIN_REGISTRO (fuera de «por facturar»)', () => {
    const v = { ...SOLICITADA, factura_estatus: 'FACTURADO' };
    expect(estadoSolicitud(v, 0)).toBe('MARCADO_SIN_REGISTRO');
    expect(esPorFacturar(v, 0)).toBe(false);
    expect(esMarcadoSinRegistro(v, 0)).toBe(true);
  });
  it('FACTURADO a mano CON una vigente ⇒ NINGUNO (ya está registrada)', () => {
    const v = { ...SOLICITADA, factura_estatus: 'FACTURADO' };
    expect(estadoSolicitud(v, 1)).toBe('NINGUNO');
    expect(esPorFacturar(v, 1)).toBe(false);
    expect(esMarcadoSinRegistro(v, 1)).toBe(false);
  });
  it('ELABORADA_ENVIADA, SIN_FACTURA y sin la llave ⇒ POR_FACTURAR (como antes)', () => {
    for (const v of [
      { ...SOLICITADA, factura_estatus: 'ELABORADA_ENVIADA' },
      { ...SOLICITADA, factura_estatus: 'SIN_FACTURA' },
      { ...SOLICITADA, factura_estatus: null },
      SOLICITADA,
    ]) {
      expect(estadoSolicitud(v, 0)).toBe('POR_FACTURAR');
      expect(esPorFacturar(v, 0)).toBe(true);
      expect(esMarcadoSinRegistro(v, 0)).toBe(false);
    }
  });
  it('FACTURADO + CANCELADO, CFDI del PAC o sin solicitud ⇒ NINGUNO', () => {
    const v = { ...SOLICITADA, factura_estatus: 'FACTURADO' };
    expect(estadoSolicitud({ ...v, estado: 'CANCELADO' }, 0)).toBe('NINGUNO');
    expect(estadoSolicitud({ ...v, facturado: true }, 0)).toBe('NINGUNO');
    expect(estadoSolicitud({ ...v, factura_solicitada_at: null }, 0)).toBe(
      'NINGUNO',
    );
    expect(estadoSolicitud(null, 0)).toBe('NINGUNO');
  });
});

describe('bloque y resumen', () => {
  it('bloque: solicitud con nombre, vigentes ordenadas, canceladas contadas, borradas fuera', () => {
    const b = bloqueFacturaServicio(
      SOLICITADA,
      [
        ligada('130', 'VIGENTE'),
        ligada('123', 'VIGENTE'),
        ligada('99', 'CANCELADA'),
        ligada('50', 'VIGENTE', { deleted_at: '2026-09-24T00:00:00Z' }),
      ],
      'Itzi',
    );
    expect(b.solicitud).toEqual({
      solicitada_at: '2026-09-24T15:00:00Z',
      solicitada_por: { id: 'u-itzi', nombre: 'Itzi' },
      nota: 'Lo necesita para pagar',
      paga_contra_factura: true,
    });
    expect(b.por_facturar).toBe(false);
    expect(b.facturas.map((f) => f.etiqueta)).toEqual(['A-123', 'A-130']);
    expect(b.facturas[0]).toMatchObject({
      total: 8050.4,
      moneda: 'USD',
      metodo_pago: 'PPD',
      tiene_pdf: true,
      tiene_xml: false,
    });
    expect(b.canceladas).toBe(1);
    expect(b.marcado_sin_registro).toBe(false);
  });

  it('bloque: FACTURADO a mano con solo canceladas ⇒ marcado_sin_registro (y no por_facturar)', () => {
    const b = bloqueFacturaServicio(
      { ...SOLICITADA, factura_estatus: 'FACTURADO' },
      [ligada('99', 'CANCELADA')],
      'Itzi',
    );
    expect(b.por_facturar).toBe(false);
    expect(b.marcado_sin_registro).toBe(true);
    expect(b.solicitud?.solicitada_por).toEqual({
      id: 'u-itzi',
      nombre: 'Itzi',
    });
    // Con la factura ya registrada, ninguna de las dos.
    const conVigente = bloqueFacturaServicio(
      { ...SOLICITADA, factura_estatus: 'FACTURADO' },
      [ligada('440', 'VIGENTE')],
    );
    expect(conVigente.por_facturar).toBe(false);
    expect(conVigente.marcado_sin_registro).toBe(false);
  });

  it('resumen de la lista', () => {
    expect(
      resumenFacturaServicio(SOLICITADA, [ligada('1', 'CANCELADA')]),
    ).toEqual({
      solicitada: true,
      por_facturar: true,
      paga_contra_factura: true,
      facturas: 0,
    });
    expect(resumenFacturaServicio({ estado: 'CONFIRMADO' }, [])).toEqual({
      solicitada: false,
      por_facturar: false,
      paga_contra_factura: false,
      facturas: 0,
    });
    // FACTURADO a mano: sigue «solicitada», ya no «por facturar» (el chip
    // ámbar de las listas desaparece; la forma del resumen no cambia).
    expect(
      resumenFacturaServicio(
        { ...SOLICITADA, factura_estatus: 'FACTURADO' },
        [],
      ),
    ).toEqual({
      solicitada: true,
      por_facturar: false,
      paga_contra_factura: true,
      facturas: 0,
    });
  });
});

describe('elegirDestinatarios (nivel ANTES de excluir)', () => {
  const mary = { id: 'u-mary', nombre: 'Mary Cruz' };
  const ale = { id: 'u-ale', nombre: 'Alejandro' };
  const fact = { id: 'u-fact', nombre: 'Facturista' };

  it('config manda', () => {
    expect(
      elegirDestinatarios(
        { config: [mary], facturacion: [fact], admins: [ale] },
        'u-itzi',
      ),
    ).toEqual({ fuente: 'CONFIG', destinatarios: [mary] });
  });
  it('sin config ⇒ rol FACTURACION; sin él ⇒ ADMIN (menos quien pidió)', () => {
    expect(
      elegirDestinatarios(
        { config: [], facturacion: [fact], admins: [ale] },
        null,
      ),
    ).toEqual({ fuente: 'ROL_FACTURACION', destinatarios: [fact] });
    expect(
      elegirDestinatarios(
        { config: [], facturacion: [], admins: [ale, mary] },
        'u-ale',
      ),
    ).toEqual({ fuente: 'ADMINS', destinatarios: [mary] });
  });
  it('si quien pide ES el único del nivel, nadie recibe aviso (no baja de nivel)', () => {
    expect(
      elegirDestinatarios(
        { config: [mary], facturacion: [fact], admins: [ale] },
        'u-mary',
      ),
    ).toEqual({ fuente: 'CONFIG', destinatarios: [] });
  });
});

describe('textos de los avisos (§5)', () => {
  it('fechaDiaMes en hora Cancún sin día de la semana', () => {
    // 27 sep 04:00 UTC = 26 sep 23:00 Cancún.
    expect(fechaDiaMes('2026-09-27T04:00:00Z')).toBe('26 sep');
    expect(fechaDiaMes(null)).toBe('');
  });

  it('solicitud de un vuelo con total, paga contra factura y nota', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [
          {
            folio: 341,
            fecha_vuelo: '2026-09-27T14:00:00Z',
            monto_total_usd: '8050.4',
          },
        ],
        cliente: 'Maqar',
        pagaContraFactura: true,
        nota: 'Mandó datos por correo',
      }),
    ).toEqual({
      titulo: 'Factura pedida: vuelo #341',
      cuerpo:
        'Itzi pidió factura del vuelo #341 · Maqar · 27 sep · Total $8,050.40 USD. El cliente paga hasta recibir la factura. Nota: Mandó datos por correo',
    });
  });

  it('sin precio ni fecha se omiten (nunca «Total $0 USD»)', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [{ folio: 12, fecha_vuelo: null, monto_total_usd: 0 }],
        cliente: null,
      }).cuerpo,
    ).toBe('Itzi pidió factura del vuelo #12.');
  });

  it('grupo: una sola notificación con todos los folios', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [
          { folio: 343, fecha_vuelo: '2026-09-27T14:00:00Z' },
          { folio: 341, fecha_vuelo: '2026-09-27T14:00:00Z' },
          { folio: 342, fecha_vuelo: '2026-09-27T14:00:00Z' },
        ],
        cliente: 'Maqar',
        grupoFolio: 12,
      }),
    ).toEqual({
      titulo: 'Factura pedida: grupo G-12',
      cuerpo:
        'Itzi pidió factura de los vuelos #341, #342 y #343 (grupo G-12) · Maqar · 27 sep.',
    });
  });

  it('factura emitida a quien la pidió', () => {
    expect(
      textoAvisoEmitida({
        actor: 'Mary Cruz',
        etiqueta: 'A-123',
        folios: [341],
        cliente: 'Maqar',
      }),
    ).toEqual({
      titulo: 'Ya está la factura A-123',
      cuerpo: 'Mary Cruz registró la factura A-123 del vuelo #341 · Maqar.',
    });
    expect(
      textoAvisoEmitida({
        actor: 'Mary Cruz',
        etiqueta: 'A-123',
        folios: [342, 341],
        cliente: 'Maqar',
      }).cuerpo,
    ).toBe(
      'Mary Cruz registró la factura A-123 de los vuelos #341 y #342 · Maqar.',
    );
  });
});

describe('solicitud AUTOMÁTICA por un cobro que exige factura (13-oct-2026, invariante 60)', () => {
  const vuelo341 = {
    folio: 341,
    fecha_vuelo: '2026-09-27T14:00:00Z',
    monto_total_usd: '8050.4',
  };

  it('sin `automatica` la salida es byte a byte la de siempre', () => {
    const base = {
      actor: 'Itzi',
      vuelos: [vuelo341],
      cliente: 'Maqar',
      pagaContraFactura: true,
      nota: 'Mandó datos por correo',
    };
    expect(textoAvisoSolicitud({ ...base, automatica: undefined })).toEqual(
      textoAvisoSolicitud(base),
    );
    expect(textoAvisoSolicitud(base).titulo).toBe('Factura pedida: vuelo #341');
  });

  it('vuelo con cliente, fecha y total: título y cuerpo exactos; nunca «Nota:» ni «paga contra factura»', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [vuelo341],
        cliente: 'Maqar',
        pagaContraFactura: true,
        nota: 'Mandó datos por correo',
        automatica: { origen: 'en HSBC Pesos' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: vuelo #341',
      cuerpo:
        'Cobro en HSBC Pesos registrado por Itzi: el vuelo #341 necesita factura · Maqar · 27 sep · Total $8,050.40 USD.',
    });
  });

  it('sin fecha ni total se omiten los tramos; sin cuenta el origen es «por Transferencia»', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Alguien de la oficina',
        vuelos: [{ folio: 12, fecha_vuelo: null, monto_total_usd: 0 }],
        cliente: null,
        automatica: { origen: 'por Transferencia' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: vuelo #12',
      cuerpo:
        'Cobro por Transferencia registrado por Alguien de la oficina: el vuelo #12 necesita factura.',
    });
  });

  it('grupo con folio G-12 y grupo sin folio', () => {
    const vuelos = [
      { folio: 343, fecha_vuelo: '2026-09-27T14:00:00Z' },
      { folio: 341, fecha_vuelo: '2026-09-27T14:00:00Z' },
      { folio: 342, fecha_vuelo: '2026-09-27T14:00:00Z' },
    ];
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos,
        cliente: 'Maqar',
        grupoFolio: 12,
        automatica: { origen: 'en HSBC Pesos' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: grupo G-12',
      cuerpo:
        'Cobro en HSBC Pesos registrado por Itzi: los vuelos #341, #342 y #343 (grupo G-12) necesitan factura · Maqar · 27 sep.',
    });
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos,
        cliente: 'Maqar',
        grupoFolio: null,
        automatica: { origen: 'por Cheque' },
      }),
    ).toEqual({
      titulo: 'Factura pendiente: vuelos #341, #342 y #343',
      cuerpo:
        'Cobro por Cheque registrado por Itzi: los vuelos #341, #342 y #343 necesitan factura · Maqar · 27 sep.',
    });
  });

  it('notaSolicitudAutomatica: prefijo + origen, recortada al tope del CHECK', () => {
    expect(notaSolicitudAutomatica('en HSBC Pesos')).toBe(
      'Solicitada automáticamente: cobro en HSBC Pesos',
    );
    expect(notaSolicitudAutomatica('por Transferencia')).toBe(
      'Solicitada automáticamente: cobro por Transferencia',
    );
    const larga = notaSolicitudAutomatica('x'.repeat(600));
    expect(larga).toHaveLength(LIMITE_NOTA_SOLICITUD);
    expect(larga.startsWith(PREFIJO_NOTA_SOLICITUD_AUTOMATICA)).toBe(true);
  });
});
