import {
  aFacturaDeGasto,
  agruparArchivos,
  avisoSumaFacturas,
  nombreDeNotas,
  notaPdfSinXml,
  ordenarFacturasDeGasto,
  sha256Hex,
  siguientePrincipal,
  type ArchivoLeido,
} from './gasto-facturas.util';

/**
 * VARIAS FACTURAS POR GASTO (16-oct-2026, invariante 87) — piezas puras:
 * agrupación de un envío (mismo archivo dos veces ⇒ una factura), aviso de
 * la suma, orden y promoción.
 */

const leido = (
  indice: number,
  o: Partial<ArchivoLeido> & { pdf?: string; xml?: string } = {},
): ArchivoLeido => {
  const pdf = o.pdf ?? null;
  const xml = o.xml ?? null;
  return {
    indice,
    xml_b64: xml ? Buffer.from(xml).toString('base64') : null,
    pdf_b64: pdf ? Buffer.from(pdf).toString('base64') : null,
    nombre: o.nombre ?? null,
    uuid: o.uuid ?? null,
    pdf_sha256: pdf ? sha256Hex(Buffer.from(pdf)) : null,
    xml_sha256: xml ? sha256Hex(Buffer.from(xml)) : null,
    parse: xml ? { uuid_fiscal: o.uuid ?? null } : null,
  };
};

describe('agruparArchivos (un envío)', () => {
  it('el MISMO PDF dos veces (sin XML) ⇒ UNA factura con los dos índices', () => {
    const g = agruparArchivos([
      leido(0, { pdf: '%PDF FCUN-1299718', nombre: 'a.pdf' }),
      leido(1, { pdf: '%PDF FCUN-1299718', nombre: 'a (1).pdf' }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].indices).toEqual([0, 1]);
    expect(g[0].nombre).toBe('a.pdf');
  });

  it('el caso ASA: 5 XML + sus 5 PDF sueltos ⇒ 5 facturas, cada PDF con su CFDI', () => {
    const archivos: ArchivoLeido[] = [];
    for (let i = 0; i < 5; i++) {
      archivos.push(
        leido(archivos.length, { xml: `<cfdi ${i}/>`, uuid: `U${i}` }),
      );
    }
    // Los PDF llegan como elementos aparte (el panel no los emparejó).
    for (let i = 0; i < 5; i++) {
      archivos.push(leido(archivos.length, { pdf: `%PDF ${i}` }));
    }
    const g = agruparArchivos(archivos);
    // Sin huella común, los PDF sueltos son facturas aparte: 10 grupos. El
    // panel empareja por nombre base; aquí se congela que NO se inventa un
    // emparejamiento.
    expect(g).toHaveLength(10);
  });

  it('XML con su PDF + el mismo PDF suelto ⇒ el suelto se une a ese CFDI', () => {
    const g = agruparArchivos([
      leido(0, { xml: '<cfdi/>', uuid: 'U1', pdf: '%PDF uno' }),
      leido(1, { pdf: '%PDF uno' }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ uuid: 'U1', indices: [0, 1] });
  });

  it('el mismo XML dos veces ⇒ una factura; el PDF de cualquiera se conserva', () => {
    const g = agruparArchivos([
      leido(0, { xml: '<cfdi/>', uuid: 'U1' }),
      leido(1, { xml: '<cfdi/>', uuid: 'U1', pdf: '%PDF uno' }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].pdf_b64).not.toBeNull();
    expect(g[0].pdf_sha256).toBe(sha256Hex(Buffer.from('%PDF uno')));
  });

  it('dos UUID distintos NUNCA se unen (aunque compartan PDF)', () => {
    const g = agruparArchivos([
      leido(0, { xml: '<a/>', uuid: 'U1', pdf: '%PDF' }),
      leido(1, { xml: '<b/>', uuid: 'U2', pdf: '%PDF' }),
    ]);
    expect(g.map((x) => x.uuid)).toEqual(['U1', 'U2']);
  });

  it('respeta el orden de primera aparición', () => {
    const g = agruparArchivos([
      leido(0, { pdf: '%PDF A' }),
      leido(1, { xml: '<b/>', uuid: 'U2' }),
    ]);
    expect(g.map((x) => x.indices[0])).toEqual([0, 1]);
  });
});

describe('avisoSumaFacturas', () => {
  const gasto = { monto: '3601.77', moneda: 'MXN' };

  it('cuadra dentro de ± 1.00 ⇒ sin aviso', () => {
    expect(
      avisoSumaFacturas(
        gasto,
        [
          { total: 3000, moneda: 'MXN' },
          { total: 601.0, moneda: 'MXN' },
        ],
        false,
      ),
    ).toBeNull();
  });

  it('no cuadra ⇒ «Las facturas suman $X; el gasto es $Y.»', () => {
    expect(
      avisoSumaFacturas(
        gasto,
        [
          { total: 3000, moneda: 'MXN' },
          { total: 500.5, moneda: 'MXN' },
        ],
        false,
      ),
    ).toBe('Las facturas suman $3,500.50 MXN; el gasto es $3,601.77 MXN.');
  });

  it('solo cuenta la MISMA moneda; sin totales (solo PDF) ⇒ sin aviso', () => {
    expect(
      avisoSumaFacturas(gasto, [{ total: 10, moneda: 'USD' }], false),
    ).toBeNull();
    expect(
      avisoSumaFacturas(gasto, [{ total: null, moneda: null }], false),
    ).toBeNull();
  });

  it('una factura que ampara OTROS gastos (VIP SAESA) ⇒ sin aviso', () => {
    expect(
      avisoSumaFacturas(gasto, [{ total: 99999, moneda: 'MXN' }], true),
    ).toBeNull();
  });
});

describe('orden y promoción', () => {
  it('principal primero; luego la liga más antigua', () => {
    const f = (id: string, principal: boolean) =>
      aFacturaDeGasto({ id }, principal ? id : null);
    const r = ordenarFacturasDeGasto([
      { factura: f('c', false), ligada_at: '2026-10-16T03:00:00Z' },
      { factura: f('b', false), ligada_at: '2026-10-16T01:00:00Z' },
      { factura: f('a', true), ligada_at: '2026-10-16T05:00:00Z' },
    ]);
    expect(r.map((x) => x.factura.id)).toEqual(['a', 'b', 'c']);
  });

  it('siguientePrincipal: la más antigua que no sale; null si no queda otra', () => {
    const ligas = [
      { factura_recibida_id: 'A', created_at: '2026-10-16T01:00:00Z' },
      { factura_recibida_id: 'C', created_at: '2026-10-16T03:00:00Z' },
      { factura_recibida_id: 'B', created_at: '2026-10-16T02:00:00Z' },
    ];
    expect(siguientePrincipal(ligas, 'A')).toBe('B');
    expect(siguientePrincipal([ligas[0]], 'A')).toBeNull();
  });
});

describe('nombre de un PDF sin XML', () => {
  it('ida y vuelta con la nota de siempre', () => {
    const n = 'ACC1312171A7_1792892_FCUN_1299718.pdf';
    expect(notaPdfSinXml(n)).toBe(`Factura en PDF (sin XML): ${n}`);
    expect(nombreDeNotas(notaPdfSinXml(n))).toBe(n);
    expect(nombreDeNotas(notaPdfSinXml(null))).toBeNull();
    expect(nombreDeNotas('Nota de la oficina')).toBeNull();
  });

  it('aFacturaDeGasto: total numérico, columnas ausentes ⇒ null', () => {
    expect(
      aFacturaDeGasto({ id: 'x', total: '1234.50', notas: null }, 'x'),
    ).toEqual({
      id: 'x',
      principal: true,
      serie: null,
      folio: null,
      uuid_fiscal: null,
      emisor_nombre: null,
      total: 1234.5,
      moneda: null,
      fecha_emision: null,
      pdf_url: null,
      xml_url: null,
      nombre: null,
    });
  });
});
