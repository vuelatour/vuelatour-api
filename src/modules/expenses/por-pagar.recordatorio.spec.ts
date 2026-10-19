import {
  LINK_GASTOS_POR_PAGAR,
  LINK_NOMINA,
  claveRecordatorioPorPagar,
  cuerpoRecordatorioPorPagar,
  destinatariosRecordatorioPorPagar,
  linkRecordatorioPorPagar,
  type UsuarioRecordatorio,
} from './por-pagar.util';

/**
 * RECORDATORIO de gastos «por pagar» — revisión del 19-oct-2026 (invariante
 * 93): P15 (destinatarios = el DUEÑO del gasto y, si es otra persona de
 * oficina, quien lo capturó; dedupe por destinatario) y P2 (una NÓMINA se
 * marca pagada en el módulo Nómina: su link y su cuerpo lo dicen).
 */
const PABLO = 'u-pablo'; // piloto, dueño del gasto
const COORD = 'u-coord'; // coordinador que lo capturó «a nombre del piloto»
const LUIS = 'u-luis'; // otro piloto
const BAJA = 'u-baja'; // oficina dada de baja

const usuarios = new Map<string, UsuarioRecordatorio>([
  [PABLO, { activo: true, rol: 'PILOTO' }],
  [COORD, { activo: true, rol: 'COORDINADOR' }],
  [LUIS, { activo: true, rol: 'PILOTO' }],
  [BAJA, { activo: false, rol: 'ADMIN' }],
]);

describe('por-pagar.util — destinatarios del recordatorio (P15)', () => {
  it('capturado «a nombre del piloto»: le llega al piloto (dueño) Y al coordinador que lo capturó', () => {
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: PABLO, created_by: COORD },
        usuarios,
      ),
    ).toEqual([PABLO, COORD]);
  });

  it('capturado por el propio dueño: un solo destinatario', () => {
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: PABLO, created_by: PABLO },
        usuarios,
      ),
    ).toEqual([PABLO]);
  });

  it('sin `usuario_captura_id`: el dueño es `created_by` (filas viejas)', () => {
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: null, created_by: COORD },
        usuarios,
      ),
    ).toEqual([COORD]);
  });

  it('`created_by` de CAMPO distinto del dueño no recibe el aviso (no es de oficina)', () => {
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: PABLO, created_by: LUIS },
        usuarios,
      ),
    ).toEqual([PABLO]);
  });

  it('dueño inactivo: solo la oficina activa que lo capturó', () => {
    const conPabloDeBaja = new Map(usuarios);
    conPabloDeBaja.set(PABLO, { activo: false, rol: 'PILOTO' });
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: PABLO, created_by: COORD },
        conPabloDeBaja,
      ),
    ).toEqual([COORD]);
  });

  it('oficina inactiva, usuario desconocido o sin nadie ⇒ no se avisa a esa persona', () => {
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: PABLO, created_by: BAJA },
        usuarios,
      ),
    ).toEqual([PABLO]);
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: 'u-no-existe', created_by: 'u-tampoco' },
        usuarios,
      ),
    ).toEqual([]);
    expect(
      destinatariosRecordatorioPorPagar(
        { usuario_captura_id: null, created_by: null },
        usuarios,
      ),
    ).toEqual([]);
  });

  it('el dedupe lleva al destinatario: dos personas, dos claves', () => {
    expect(claveRecordatorioPorPagar('g-1', '2026-10-25', PABLO)).toBe(
      'gasto_por_pagar:g-1:2026-10-25:u-pablo',
    );
    expect(claveRecordatorioPorPagar('g-1', '2026-10-25', COORD)).not.toBe(
      claveRecordatorioPorPagar('g-1', '2026-10-25', PABLO),
    );
  });
});

describe('por-pagar.util — la NÓMINA se marca en Nómina (P2)', () => {
  it('link: NÓMINA ⇒ /admin/nomina?mes=<YYYY-MM de su fecha_gasto>; lo demás ⇒ Gastos con el filtro', () => {
    expect(LINK_NOMINA).toBe('/admin/nomina');
    expect(
      linkRecordatorioPorPagar({
        categoria: 'NOMINA',
        fecha_gasto: '2026-10-30',
      }),
    ).toBe('/admin/nomina?mes=2026-10');
    expect(
      linkRecordatorioPorPagar({
        categoria: 'TAXI',
        fecha_gasto: '2026-10-30',
      }),
    ).toBe(LINK_GASTOS_POR_PAGAR);
    // Fecha ilegible (no pasa: NOT NULL) ⇒ el módulo sin mes.
    expect(
      linkRecordatorioPorPagar({ categoria: 'NOMINA', fecha_gasto: null }),
    ).toBe('/admin/nomina');
  });

  it('cuerpo: NÓMINA termina «(Nómina en el panel).»; los demás, como siempre', () => {
    expect(
      cuerpoRecordatorioPorPagar({
        categoria: 'NOMINA',
        monto: 45000,
        moneda: 'MXN',
        folio: null,
      }),
    ).toBe(
      'Nómina · $45,000 MXN — cuando lo pagues, márcalo pagado (Nómina en el panel).',
    );
    expect(
      cuerpoRecordatorioPorPagar({
        categoria: 'TAXI',
        monto: 500,
        moneda: 'MXN',
        folio: 436,
      }),
    ).toBe(
      'Taxi / estacionamiento · $500 MXN · vuelo #436 — cuando lo pagues, márcalo pagado (Mis registros en la app, o Gastos en el panel).',
    );
  });
});
