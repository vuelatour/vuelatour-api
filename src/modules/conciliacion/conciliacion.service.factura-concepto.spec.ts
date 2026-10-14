import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { sembrarPartes } from './conciliacion-partes.fixture-spec';
import {
  fakePostgrest,
  type OpcionesFake,
  type Row,
  type Tablas,
} from './conciliacion-postgrest.fixture-spec';

/**
 * «Factura NNNN» EN CONCILIACIÓN (13-oct-2026, API 0.0.75, invariante 69):
 * - la lista lleva `factura_concepto` en cada fila cuyo concepto cita una
 *   factura, con la coherencia contra sus gastos (`ligados`) y si la MISMA
 *   factura sale en otro pago (`repetida_en`, UNA consulta por página; null
 *   = no verificado);
 * - «Vincular gasto» marca `coincide_factura` (señal dentro de su nivel) y
 *   lista los `otros_gastos` que tienen esa factura;
 * - sin factura en el concepto, todo sale como el 0.0.74.
 */
const CTA = 'cta-eje';
const CTA_GG = 'cta-gg';
const SPEI = 'SEL TRANSF. INTERBANCARIA SPEI';

function armar(db: Tablas, opts: OpcionesFake = {}) {
  sembrarPartes(db);
  const fake = fakePostgrest(db, opts);
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    fake.supabase,
    {} as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, ...fake };
}

const mov = (
  id: string,
  fecha: string,
  monto: number,
  descripcion: string,
  extra: Row = {},
): Row => ({
  id,
  cuenta_bancaria_id: CTA,
  fecha,
  tipo: 'CARGO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion,
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  origen: 'IMPORTADO',
  notas: null,
  created_at: `${fecha}T12:00:00Z`,
  ...extra,
});

const gasto = (id: string, monto: number, extra: Row = {}): Row => ({
  id,
  monto,
  moneda: 'MXN',
  fecha_gasto: '2026-10-12',
  medio_pago: 'TRANSFERENCIA',
  conciliado: false,
  tarjeta_terminacion: null,
  lugar: null,
  notas: null,
  categoria: 'PISTA',
  vuelo_id: null,
  proveedor_id: null,
  folio_ticket: null,
  factura_recibida_id: null,
  ...extra,
});

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      { id: CTA, moneda: 'MXN', tipo: 'BANCO', alias: 'EJE SCOTIA' },
      { id: CTA_GG, moneda: 'MXN', tipo: 'BANCO', alias: 'GASTOS GNRAL' },
    ],
    tarjeta_corporativa: [],
    proveedor: [],
    vuelo: [],
    factura_recibida: [],
    gasto: [],
    movimiento_bancario: [],
    ...extra,
  };
}

const esUniverso = (o: {
  tabla: string;
  op: string;
  filtros: Array<[string, string, unknown]>;
}) =>
  o.tabla === 'movimiento_bancario' &&
  o.op === 'select' &&
  o.filtros.some(([f, c]) => f === 'ilike' && c === 'descripcion');

describe('GET movimientos — factura_concepto', () => {
  it('1 ↔ 1: COINCIDE con el folio del gasto y la respuesta del gasto NO crece (sin notas_fc)', async () => {
    const db = mundo({
      gasto: [gasto('g1', 2231.38, { conciliado: true, folio_ticket: '7360' })],
      movimiento_bancario: [
        mov('m1', '2026-10-12', 2231.38, `${SPEI} BANORTE fact vip 7360`, {
          conciliado: true,
          gasto_id: 'g1',
        }),
      ],
    });
    const { svc, log } = armar(db);
    const { data } = await svc.list({ limit: 50, offset: 0 });
    expect(data[0].factura_concepto).toEqual({
      tipo: 'FACTURA',
      numeros: ['7360'],
      texto: 'Factura 7360',
      pista: 'VIP',
      ligados: { estado: 'COINCIDE', folios: ['7360'], faltan: [] },
      repetida_en: [],
    });
    expect(data[0].gasto).not.toHaveProperty('notas_fc');
    expect((data[0].gasto as Row).folio_comprobante).toBe('7360');
    expect(log.filter(esUniverso)).toHaveLength(1);
  });

  it('el gasto dice OTRA factura ⇒ NO_COINCIDE (posible liga equivocada)', async () => {
    const db = mundo({
      gasto: [
        gasto('g1', 2231.38, {
          conciliado: true,
          notas: 'Pago VIP SAESA fact 7361',
        }),
      ],
      movimiento_bancario: [
        mov('m1', '2026-10-12', 2231.38, `${SPEI} BANORTE fact vip 7360`, {
          conciliado: true,
          gasto_id: 'g1',
        }),
      ],
    });
    const { data } = await armar(db).svc.list({ limit: 50, offset: 0 });
    expect((data[0].factura_concepto as Row).ligados).toEqual({
      estado: 'NO_COINCIDE',
      folios: ['7361'],
      faltan: ['7360'],
    });
  });

  it('lote (2 gastos por la puente): ligados con los folios de las partes', async () => {
    const db = mundo({
      gasto: [
        gasto('g1', 2231.37, { conciliado: true, folio_ticket: '7359' }),
        gasto('g2', 2231.38, { conciliado: true, folio_ticket: '7360' }),
      ],
      movimiento_bancario: [
        mov('m1', '2026-10-12', 4462.75, `${SPEI} BANORTE FACT 7359 Y 7360`, {
          conciliado: true,
        }),
      ],
      movimiento_bancario_gasto: [
        {
          movimiento_id: 'm1',
          gasto_id: 'g1',
          monto_parte: 2231.37,
          moneda: 'MXN',
          created_at: '2026-10-12T00:00:00Z',
        },
        {
          movimiento_id: 'm1',
          gasto_id: 'g2',
          monto_parte: 2231.38,
          moneda: 'MXN',
          created_at: '2026-10-12T00:00:01Z',
        },
      ],
    });
    const { data } = await armar(db).svc.list({ limit: 50, offset: 0 });
    expect(data[0].gastos_n).toBe(2);
    expect((data[0].factura_concepto as Row).ligados).toEqual({
      estado: 'COINCIDE',
      folios: ['7359', '7360'],
      faltan: [],
    });
  });

  it('ABONO ⇒ ligados null; pendiente sin gasto ⇒ ligados null', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov('a1', '2026-10-12', 1000, 'SCN Pagos a Proveedores fact 1234', {
          tipo: 'ABONO',
        }),
        mov('m2', '2026-10-12', 1118.12, `${SPEI} BANORTE fact vip 7357`),
      ],
    });
    const { data } = await armar(db).svc.list({ limit: 50, offset: 0 });
    for (const fila of data) {
      expect((fila.factura_concepto as Row).ligados).toBeNull();
    }
  });

  it('repetida_en: la MISMA factura en otra cuenta a ≤ 120 días, con UNA consulta por página', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov('m-oct', '2026-10-12', 1118.12, `${SPEI} BANORTE fact vip 7357`),
        mov('m-sep', '2026-09-07', 1118.12, `${SPEI} BANORTE fact vip 7357`, {
          cuenta_bancaria_id: CTA_GG,
          conciliado: true,
        }),
        mov('m-otra', '2026-10-01', 500, `${SPEI} HSBC fact palma 7357`),
      ],
    });
    const { svc, log } = armar(db);
    const { data } = await svc.list({ limit: 50, offset: 0 });
    const oct = data.find((m) => m.id === 'm-oct')!;
    expect((oct.factura_concepto as Row).repetida_en).toEqual([
      {
        movimiento_id: 'm-sep',
        fecha: '2026-09-07',
        monto: 1118.12,
        cuenta: 'GASTOS GNRAL',
        descripcion: `${SPEI} BANORTE fact vip 7357`,
        conciliado: true,
      },
    ]);
    // VIP ≠ PALMA: la de HSBC no cuenta como repetida.
    const otra = data.find((m) => m.id === 'm-otra')!;
    expect((otra.factura_concepto as Row).repetida_en).toEqual([]);
    expect(log.filter(esUniverso)).toHaveLength(1);
  });

  it('si la consulta del universo falla ⇒ repetida_en null y la lista sigue', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov('m1', '2026-10-12', 1118.12, `${SPEI} BANORTE fact vip 7357`),
      ],
    });
    const { svc } = armar(db, {
      antes: (op) => (esUniverso(op) ? { message: 'timeout' } : undefined),
    });
    const { data } = await svc.list({ limit: 50, offset: 0 });
    expect(data).toHaveLength(1);
    expect((data[0].factura_concepto as Row).repetida_en).toBeNull();
    expect((data[0].factura_concepto as Row).texto).toBe('Factura 7357');
  });

  it('si el universo llega a 1000 filas (tope de PostgREST) ⇒ null: jamás «no se repite» de una foto recortada', async () => {
    const muchos = Array.from({ length: 1000 }, (_, i) =>
      mov(
        `f${String(i).padStart(4, '0')}`,
        '2026-09-20',
        100 + i,
        `fact ${1000 + i}`,
      ),
    );
    const db = mundo({
      movimiento_bancario: [
        ...muchos,
        mov('m1', '2026-10-12', 1118.12, `${SPEI} BANORTE fact vip 7357`),
      ],
    });
    const { data } = await armar(db).svc.list({ limit: 5, offset: 0 });
    const m1 = data.find((m) => m.id === 'm1')!;
    expect((m1.factura_concepto as Row).repetida_en).toBeNull();
  });

  it('una página sin ninguna factura: cero consultas extra y ninguna llave nueva', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov('m1', '2026-10-12', 825.13, 'ASA CANCUN'),
        mov(
          'm2',
          '2026-10-11',
          16,
          'SEL PAGO DE SERVICIOS PAGO REFERENCIADO SAT',
        ),
      ],
    });
    const { svc, log } = armar(db);
    const { data } = await svc.list({ limit: 50, offset: 0 });
    expect(data.every((m) => !('factura_concepto' in m))).toBe(true);
    expect(log.filter(esUniverso)).toEqual([]);
  });
});

describe('GET movimientos/:id/gastos-candidatos — coincide_factura y otros_gastos', () => {
  const cargo = (descripcion: string) =>
    mov('c1', '2026-10-12', 2231.38, descripcion);

  it('coincide_factura por cada fuente (factura recibida, ticket, IA, «fact NNNN» en la nota) y va primero en su nivel', async () => {
    const db = mundo({
      factura_recibida: [
        { id: 'fr-1', serie: null, folio: '7352', uuid_fiscal: 'u' },
      ],
      gasto: [
        gasto('g-otro', 2231.38, {
          folio_ticket: '7353',
          fecha_gasto: '2026-10-12',
        }),
        gasto('g-recibida', 2231.38, {
          factura_recibida_id: 'fr-1',
          fecha_gasto: '2026-10-01',
        }),
        gasto('g-ticket', 2231.38, {
          folio_ticket: '7352',
          fecha_gasto: '2026-10-02',
        }),
        gasto('g-ia', 2231.38, {
          valor_ia_extraido: { folio: '7352' },
          fecha_gasto: '2026-10-03',
        }),
        gasto('g-nota', 2231.38, {
          notas: 'Pago VIP SAESA fact 7352',
          fecha_gasto: '2026-10-04',
        }),
      ],
      movimiento_bancario: [cargo(`${SPEI} BANORTE fact vip 7352`)],
    });
    const r = await armar(db).svc.gastosCandidatosDeMovimiento('c1', {});
    const marca = Object.fromEntries(
      r.candidatos.map((c) => [c.id, c.coincide_factura]),
    );
    expect(marca).toEqual({
      'g-recibida': true,
      'g-ticket': true,
      'g-ia': true,
      'g-nota': true,
      'g-otro': false,
    });
    // Todos cuadran: los que coinciden van primero; el otro, al final aunque
    // sea el de la fecha más cercana.
    expect(r.candidatos[r.candidatos.length - 1].id).toBe('g-otro');
    expect(r.factura_concepto).toEqual({
      tipo: 'FACTURA',
      numeros: ['7352'],
      texto: 'Factura 7352',
      pista: 'VIP',
      otros_gastos: [],
    });
  });

  it('sin factura en el concepto: ni coincide_factura ni factura_concepto (como el 0.0.74)', async () => {
    const db = mundo({
      gasto: [gasto('g1', 2231.38, { folio_ticket: '7352' })],
      movimiento_bancario: [cargo(SPEI)],
    });
    const { svc, log } = armar(db);
    const r = await svc.gastosCandidatosDeMovimiento('c1', {});
    expect(r).not.toHaveProperty('factura_concepto');
    expect(r.candidatos[0]).not.toHaveProperty('coincide_factura');
    expect(
      log.some(
        (o) => o.tabla === 'gasto' && o.filtros.some(([f]) => f === 'or'),
      ),
    ).toBe(false);
  });

  it('otros_gastos busca por DÍGITOS: la factura A-123 encuentra el folio «A-123» YA conciliado y dice con qué cargo', async () => {
    const db = mundo({
      gasto: [
        gasto('g-ya', 999, {
          conciliado: true,
          folio_ticket: 'A-123',
          fecha_gasto: '2026-09-30',
        }),
        gasto('g-otro', 999, { conciliado: true, folio_ticket: 'B-123' }),
      ],
      movimiento_bancario: [
        cargo('CGO SPEI fac A-123'),
        mov('c-viejo', '2026-09-30', 999, 'CGO SPEI', {
          cuenta_bancaria_id: CTA_GG,
          conciliado: true,
          gasto_id: 'g-ya',
        }),
      ],
    });
    const r = await armar(db).svc.gastosCandidatosDeMovimiento('c1', {});
    expect(r.factura_concepto?.texto).toBe('Factura A-123');
    expect(r.factura_concepto?.otros_gastos).toEqual([
      {
        motivo: 'YA_CONCILIADO',
        n: 1,
        gastos: [
          expect.objectContaining({
            id: 'g-ya',
            conciliado_con: [
              {
                movimiento_id: 'c-viejo',
                fecha: '2026-09-30',
                monto: 999,
                moneda: 'MXN',
                cuenta: 'GASTOS GNRAL',
              },
            ],
          }),
        ],
      },
    ]);
  });

  it('otros_gastos también por la factura RECIBIDA (folio que termina en los dígitos)', async () => {
    const db = mundo({
      factura_recibida: [
        { id: 'fr-9', serie: 'A', folio: '0411', uuid_fiscal: 'u' },
      ],
      gasto: [
        gasto('g-rec', 500, {
          conciliado: true,
          factura_recibida_id: 'fr-9',
          fecha_gasto: '2026-10-01',
        }),
      ],
      movimiento_bancario: [cargo('SPEI ENVIADO fact A-411')],
    });
    const r = await armar(db).svc.gastosCandidatosDeMovimiento('c1', {});
    expect(r.factura_concepto?.otros_gastos?.[0]).toMatchObject({
      motivo: 'YA_CONCILIADO',
      n: 1,
      gastos: [expect.objectContaining({ id: 'g-rec' })],
    });
  });

  it('si la lectura de otros_gastos falla ⇒ null y los candidatos salen igual', async () => {
    const db = mundo({
      gasto: [gasto('g1', 2231.38, { folio_ticket: '7352' })],
      movimiento_bancario: [cargo(`${SPEI} BANORTE fact vip 7352`)],
    });
    const { svc } = armar(db, {
      antes: (op) =>
        op.tabla === 'gasto' && op.filtros.some(([f]) => f === 'or')
          ? { message: 'caída' }
          : undefined,
    });
    const r = await svc.gastosCandidatosDeMovimiento('c1', {});
    expect(r.candidatos.map((c) => c.id)).toEqual(['g1']);
    expect(r.candidatos[0].coincide_factura).toBe(true);
    expect(r.factura_concepto?.otros_gastos).toBeNull();
  });

  it('«Sugerir» (IA) NO lleva la llave: la ★ es solo de «Vincular gasto»', async () => {
    const db = mundo({
      gasto: [gasto('g1', 2231.38, { folio_ticket: '7352' })],
      movimiento_bancario: [cargo(`${SPEI} BANORTE fact vip 7352`)],
    });
    const s = await armar(db).svc.sugerir('c1');
    expect(s.candidatos.map((c) => c.id)).toEqual(['g1']);
    expect(s.candidatos[0]).not.toHaveProperty('coincide_factura');
  });
});
