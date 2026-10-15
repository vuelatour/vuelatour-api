import { ConciliacionService } from './conciliacion.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { IaUsoService } from '../ia-uso/ia-uso.service';
import { fechaNota } from '../../common/vinculo-no-bancario.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { sembrarPartes } from './conciliacion-partes.fixture-spec';
import {
  escrituras,
  fakePostgrest,
  type OpcionesFake,
  type Row,
  type Tablas,
} from './conciliacion-postgrest.fixture-spec';
import {
  CANONICA,
  rpcOmisionCargos,
  RPC_OMITIR,
  RPC_QUITAR,
  type OpcionesOmision,
} from './omision-cargos.fixture-spec';
import { errorBd } from './conciliacion-partes.fixture-spec';

/**
 * «OMITIR LA CONCILIACIÓN» (14-oct-2026, API 0.0.77, invariante 75) — el
 * servicio contra un PostgREST falso que respeta CAS y embeds, con las RPC
 * de la migración 20261014000002 emuladas (`omision-cargos.fixture-spec`).
 */
const USER = 'cccccccc-0000-4000-8000-000000000001';
const CTA = 'cta-mxn';
const CTA_USD = 'cta-usd';
const PW = 'cta-paywise';
const id = (n: number) =>
  `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOY = fechaNota(hoyCancun());

function mundo(extra: Partial<Tablas> = {}): Tablas {
  return {
    cuenta_bancaria: [
      {
        id: CTA,
        alias: 'GASTOS GNRAL',
        banco: 'Scotiabank',
        moneda: 'MXN',
        tipo: 'BANCO',
        activa: true,
      },
      {
        id: CTA_USD,
        alias: 'HSBC DLLS',
        banco: 'HSBC',
        moneda: 'USD',
        tipo: 'BANCO',
        activa: true,
      },
      {
        id: PW,
        alias: 'PAYWISE',
        banco: 'Paywise',
        moneda: 'MXN',
        tipo: 'PASARELA',
        activa: true,
      },
    ],
    conciliacion_clasificacion: [
      { id: 'clasif-comision', nombre: 'Comisión del banco', activo: true },
    ],
    tarjeta_corporativa: [],
    proveedor: [],
    gasto: [],
    movimiento_bancario: [],
    cobro_vuelo: [],
    cobro_grupo: [],
    ...extra,
  };
}

const mov = (
  n: number,
  fecha: string,
  monto: number,
  extra: Row = {},
): Row => ({
  id: id(n),
  cuenta_bancaria_id: CTA,
  fecha,
  tipo: 'CARGO',
  monto,
  monto_bruto: null,
  comision_monto: null,
  descripcion: 'IVA - COMISIONES',
  referencia: null,
  conciliado: false,
  gasto_id: null,
  cobro_id: null,
  cobro_grupo_id: null,
  clasificacion_id: null,
  ingreso_id: null,
  reverso_de_id: null,
  gastos_n: 0,
  cobros_n: 0,
  origen: 'IMPORTADO',
  notas: null,
  created_at: `${fecha}T12:00:00Z`,
  ...extra,
});

function armar(
  db: Tablas,
  opts: { omision?: OpcionesOmision; fake?: OpcionesFake } = {},
) {
  sembrarPartes(db);
  const generateTablaXlsx = jest.fn().mockResolvedValue(Buffer.from('xlsx'));
  const fake = fakePostgrest(db, {
    ...opts.fake,
    rpc: (n, a, d) => rpcOmisionCargos(d, n, a, opts.omision),
  });
  const svc = new ConciliacionService(
    { get: () => '' } as unknown as ConstructorParameters<
      typeof ConciliacionService
    >[0],
    fake.supabase,
    { generateTablaXlsx } as unknown as PyservicesService,
    { registrar: jest.fn() } as unknown as IaUsoService,
  );
  return { svc, db, generateTablaXlsx, ...fake };
}

/** Sin riesgos: los cobros exactos de un abono se espían (0 por default). */
function sinCobros(svc: ConciliacionService, n = 0) {
  return jest
    .spyOn(
      svc as unknown as {
        cobrosExactosLibresDeAbono: (...a: unknown[]) => Promise<number | null>;
      },
      'cobrosExactosLibresDeAbono',
    )
    .mockResolvedValue(n);
}

async function rechazo(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    return {
      status: err.getStatus?.(),
      body: err.getResponse?.() as {
        message: string;
        error: string;
        details?: Record<string, unknown>;
      },
    };
  }
  throw new Error('se esperaba un rechazo');
}

const LINEA = (motivo: string, por: string) =>
  `Omitido de la conciliación: ${motivo} — ${por}, ${HOY}`;

describe('omitir — el camino feliz (todo o nada, línea firmada arriba)', () => {
  it('omite 2 pendientes: canónica creada, conciliados, notas con la línea ARRIBA', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-09-24', 1.12, {
          notas: 'Nota del banco\r\nsegunda línea ',
        }),
        mov(2, '2026-09-25', 7, { descripcion: 'COMISION SPEI' }),
      ],
    });
    const w = armar(db);
    sinCobros(w.svc);
    const r = await w.svc.omitirMovimientos(
      {
        movimiento_ids: [id(2), id(1).toUpperCase()],
        motivo: '  Comisión o IVA\ndel banco ',
      },
      USER,
      'Alejandro Canales',
    );
    const canonica = db.conciliacion_clasificacion.find(
      (c) => c.nombre === CANONICA,
    )!;
    expect(canonica).toBeDefined();
    expect(r.omitidos).toBe(2);
    expect(r.clasificacion_id).toBe(canonica.id);
    const [m1, m2] = db.movimiento_bancario;
    expect(m1.conciliado).toBe(true);
    expect(m1.clasificacion_id).toBe(canonica.id);
    expect(m1.notas).toBe(
      `${LINEA('Comisión o IVA del banco', 'Alejandro Canales')}\nNota del banco\r\nsegunda línea `,
    );
    expect(m2.notas).toBe(
      LINEA('Comisión o IVA del banco', 'Alejandro Canales'),
    );
    expect(m1.updated_by).toBe(USER);
    // La RPC recibió la lista normalizada y la línea armada por el API.
    const llamada = w.rpcs.find(
      (x) =>
        x.nombre === RPC_OMITIR &&
        (x.args.p_movimiento_ids as string[]).length > 0,
    )!;
    expect(llamada.args).toEqual({
      p_movimiento_ids: [id(2), id(1)],
      p_linea: LINEA('Comisión o IVA del banco', 'Alejandro Canales'),
      p_actor: USER,
    });
    // Relectura con `omision` en el orden de la petición, sin `cuenta`.
    expect(r.movimientos.map((m) => m.id)).toEqual([id(2), id(1)]);
    expect(r.movimientos[0].omision).toEqual({
      motivo: 'Comisión o IVA del banco',
      por: 'Alejandro Canales',
      fecha: HOY,
    });
    expect(r.movimientos[0]).not.toHaveProperty('cuenta');
  });

  it('sin nombre de usuario firma «Oficina»', async () => {
    const db = mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1.12)] });
    const w = armar(db);
    await w.svc.omitirMovimientos(
      { movimiento_ids: [id(1)], motivo: 'Comisión del banco' },
      USER,
      null,
    );
    expect(db.movimiento_bancario[0].notas).toBe(
      LINEA('Comisión del banco', 'Oficina'),
    );
  });
});

describe('omitir — rechazos ANTES de la RPC (nada escrito)', () => {
  it('404 si falta alguno (details.faltan)', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }));
    const r = await rechazo(
      w.svc.omitirMovimientos(
        { movimiento_ids: [id(1), id(9)], motivo: 'Comisión del banco' },
        USER,
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      message: 'Uno de los movimientos ya no existe: recarga la página.',
      error: 'MOVIMIENTO_NO_EXISTE',
      details: { faltan: [id(9)] },
    });
    expect(
      w.rpcs.filter(
        (x) =>
          x.nombre === RPC_OMITIR &&
          (x.args.p_movimiento_ids as unknown[]).length > 0,
      ),
    ).toHaveLength(0);
    expect(escrituras(w.log)).toHaveLength(0);
  });

  it('409 MOVIMIENTO_NO_PENDIENTE con el texto que nombra cada uno', async () => {
    const db = mundo({
      gasto: [
        {
          id: 'g-1',
          monto: 8468.91,
          moneda: 'MXN',
          medio_pago: 'TARJETA_CORP',
          conciliado: false,
          fecha_gasto: '2026-10-12',
        },
      ],
      movimiento_bancario: [
        mov(1, '2026-10-12', 8468.91, {
          descripcion: 'ASA CANCUN',
          conciliado: true,
          gasto_id: 'g-1',
        }),
        mov(2, '2026-09-24', 1.12),
        mov(3, '2026-09-26', 3, {
          conciliado: true,
          clasificacion_id: 'clasif-comision',
        }),
      ],
    });
    const w = armar(db);
    const r = await rechazo(
      w.svc.omitirMovimientos(
        { movimiento_ids: [id(1), id(2), id(3)], motivo: 'Comisión del banco' },
        USER,
      ),
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MOVIMIENTO_NO_PENDIENTE');
    expect(r.body.message).toBe(
      'No se omitió ninguno: 2 de los 3 movimientos ya no están pendientes — 12 oct · ASA CANCUN $8,468.91 (ya está vinculado a un gasto) · 26 sep · IVA - COMISIONES $3.00 (ya está clasificado). Recarga la lista y vuelve a seleccionar.',
    );
    expect(
      (r.body.details!.movimientos as Row[]).map((m) => [
        m.id,
        m.estado,
        m.moneda,
      ]),
    ).toEqual([
      [id(1), 'CON_GASTO', 'MXN'],
      [id(3), 'CLASIFICADO', 'MXN'],
    ]);
    expect(escrituras(w.log)).toHaveLength(0);
  });

  it('un cargo devuelto (otro abono apunta a él) es REVERSO', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-09-21', 825.13, { descripcion: 'ASUR CANCUN' }),
        mov(2, '2026-09-23', 825.13, {
          tipo: 'ABONO',
          reverso_de_id: id(1),
          conciliado: true,
        }),
      ],
    });
    const w = armar(db);
    const r = await rechazo(
      w.svc.omitirMovimientos(
        { movimiento_ids: [id(1)], motivo: 'Comisión del banco' },
        USER,
      ),
    );
    expect((r.body.details!.movimientos as Row[])[0].estado).toBe('REVERSO');
  });

  it('400 ACEPTAR_RIESGO_INVALIDO si confirma un aviso fuera de la selección', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }));
    const r = await rechazo(
      w.svc.omitirMovimientos(
        {
          movimiento_ids: [id(1)],
          motivo: 'Comisión del banco',
          aceptar_riesgo_ids: [id(7)],
        },
        USER,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      message:
        'Los movimientos con aviso que confirmas deben estar en la selección.',
      error: 'ACEPTAR_RIESGO_INVALIDO',
    });
  });

  it('409 OMITIR_CON_RIESGO (gasto que cuadra y traspaso) y se omite al CONFIRMARLOS', async () => {
    const db = mundo({
      gasto: [
        {
          id: 'g-asa',
          monto: 3216.27,
          moneda: 'MXN',
          medio_pago: 'TARJETA_CORP',
          conciliado: false,
          fecha_gasto: '2026-08-10',
          tarjeta_terminacion: null,
          lugar: null,
          notas: null,
          categoria: 'COMBUSTIBLE',
          vuelo_id: null,
          proveedor_id: null,
        },
      ],
      movimiento_bancario: [
        mov(1, '2026-08-10', 3216.27, { descripcion: 'ASA CANCUN' }),
        mov(2, '2026-07-17', 40000, {
          descripcion: 'SEL TRASPASO ENTRE CUENTAS',
        }),
        mov(3, '2026-09-24', 1.12),
      ],
    });
    const w = armar(db);
    sinCobros(w.svc);
    const dto = {
      movimiento_ids: [id(1), id(2), id(3)],
      motivo: 'Comisión del banco',
    };
    const r = await rechazo(w.svc.omitirMovimientos(dto, USER));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('OMITIR_CON_RIESGO');
    expect(r.body.message).toBe(
      '2 de los 3 movimientos podrían conciliarse de verdad: 10 ago · ASA CANCUN $3,216.27 (hay un gasto que cuadra: «Cruzar pendientes» o «Vincular gasto» lo resuelven) · 17 jul · SEL TRASPASO ENTRE CUENTAS $40,000.00 (es un traspaso entre cuentas: «Cruzar pendientes» lo clasifica solo). Quítalos de la selección o confirma que también se omiten.',
    );
    expect((r.body.details!.movimientos as Row[]).map((m) => m.riesgo)).toEqual(
      ['GASTO_QUE_CUADRA', 'TRASPASO'],
    );
    expect(escrituras(w.log)).toHaveLength(0);
    // Confirmar UNO no basta; los dos sí.
    const r2 = await rechazo(
      w.svc.omitirMovimientos({ ...dto, aceptar_riesgo_ids: [id(1)] }, USER),
    );
    expect((r2.body.details!.movimientos as Row[]).map((m) => m.id)).toEqual([
      id(2),
    ]);
    const ok = await w.svc.omitirMovimientos(
      { ...dto, aceptar_riesgo_ids: [id(1), id(2)] },
      USER,
    );
    expect(ok.omitidos).toBe(3);
    // La revisión NO mutó las filas (anota sobre COPIAS).
    expect(db.movimiento_bancario[0]).not.toHaveProperty('motivo_pendiente');
  });

  it('503 sin la migración (nada leído ni escrito más allá de la sonda)', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }), {
      omision: { sinMigracion: true },
    });
    const r = await rechazo(
      w.svc.omitirMovimientos(
        { movimiento_ids: [id(1)], motivo: 'Comisión del banco' },
        USER,
      ),
    );
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      message: 'Esta opción todavía no está activa: avisa a sistemas.',
      error: 'CONCILIACION_OMITIR_NO_DISPONIBLE',
      details: { migracion: '20261014000002' },
    });
    expect(w.log.filter((o) => o.tabla === 'movimiento_bancario')).toHaveLength(
      0,
    );
  });
});

describe('omitir — errores de la RPC traducidos (carreras)', () => {
  it('MOVIMIENTO_NO_PENDIENTE de la BD (alguien lo ligó entre la lectura y la RPC)', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-10-12', 8468.91, { descripcion: 'ASA CANCUN' }),
      ],
    });
    const w = armar(db, {
      omision: {
        fallo: (nombre, args) =>
          nombre === RPC_OMITIR &&
          (args.p_movimiento_ids as unknown[]).length > 0
            ? errorBd('MOVIMIENTO_NO_PENDIENTE', '1 de 1', {
                movimientos: [
                  {
                    id: id(1),
                    fecha: '2026-10-12',
                    tipo: 'CARGO',
                    monto: 8468.91,
                    descripcion: 'ASA CANCUN',
                    estado: 'CON_GASTO',
                  },
                ],
              })
            : null,
      },
    });
    sinCobros(w.svc);
    const r = await rechazo(
      w.svc.omitirMovimientos(
        { movimiento_ids: [id(1)], motivo: 'Comisión del banco' },
        USER,
      ),
    );
    expect(r.status).toBe(409);
    expect(r.body.message).toBe(
      'No se omitió: el movimiento ya no está pendiente — 12 oct · ASA CANCUN $8,468.91 (ya está vinculado a un gasto). Recarga la lista y vuelve a seleccionar.',
    );
  });

  it('40P01 ⇒ 409 CONFLICTO_CONCURRENTE; MOVIMIENTO_NO_EXISTE ⇒ 404 con faltan', async () => {
    const casos: Array<[unknown, number, string]> = [
      [
        { code: '40P01', message: 'deadlock detected' },
        409,
        'CONFLICTO_CONCURRENTE',
      ],
      [
        errorBd('MOVIMIENTO_NO_EXISTE', '1 ya no existen', { ids: [id(1)] }),
        404,
        'MOVIMIENTO_NO_EXISTE',
      ],
      [
        errorBd('OMISION_INVALIDA', 'forma', { largo: 0 }),
        400,
        'OMISION_INVALIDA',
      ],
    ];
    for (const [err, status, codigo] of casos) {
      const db = mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] });
      const w = armar(db, {
        omision: {
          fallo: (nombre, args) =>
            nombre === RPC_OMITIR &&
            (args.p_movimiento_ids as unknown[]).length > 0
              ? err
              : null,
        },
      });
      const r = await rechazo(
        w.svc.omitirMovimientos(
          { movimiento_ids: [id(1)], motivo: 'Comisión del banco' },
          USER,
        ),
      );
      expect([r.status, r.body.error]).toEqual([status, codigo]);
      if (codigo === 'MOVIMIENTO_NO_EXISTE') {
        expect(r.body.details).toEqual({ faltan: [id(1)] });
      }
    }
  });
});

describe('revisar la selección (solo lectura; funciona sin la migración)', () => {
  it('estados, riesgos, no_existen y resumen', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-09-24', 1.12),
        mov(2, '2026-09-25', 20400, {
          tipo: 'ABONO',
          descripcion: 'SPEI RECIBIDO MAQAR',
          cuenta_bancaria_id: CTA,
        }),
        mov(3, '2026-09-26', 500, {
          tipo: 'ABONO',
          descripcion: 'CARGO INDEBIDO 21 SEP',
        }),
        mov(4, '2026-09-26', 9, {
          conciliado: true,
          clasificacion_id: 'clasif-comision',
        }),
        mov(5, '2026-09-27', 10, { cuenta_bancaria_id: 'cta-sin-moneda' }),
      ],
    });
    const w = armar(db, { omision: { sinMigracion: true } });
    const espia = sinCobros(w.svc);
    espia.mockImplementation((abono: unknown) =>
      Promise.resolve(
        Number((abono as { monto: number }).monto) === 20400 ? 1 : 0,
      ),
    );
    const r = await w.svc.revisarOmision([
      id(1),
      id(2),
      id(3),
      id(4),
      id(5),
      id(9),
    ]);
    const por = new Map(r.movimientos.map((m) => [m.id, m]));
    expect(por.get(id(1))).toMatchObject({
      estado: 'PENDIENTE',
      riesgo: null,
      texto_estado: null,
      moneda: 'MXN',
      cuenta_alias: 'GASTOS GNRAL',
    });
    expect(por.get(id(2))).toMatchObject({
      estado: 'PENDIENTE',
      riesgo: 'COBRO_QUE_CUADRA',
      texto_riesgo: 'hay un cobro de vuelo que cuadra: vincúlalo a ese cobro',
    });
    expect(por.get(id(3))).toMatchObject({ riesgo: 'DEVOLUCION' });
    expect(por.get(id(4))).toMatchObject({
      estado: 'CLASIFICADO',
      texto_estado: 'ya está clasificado',
      riesgo: null,
    });
    // Cuenta sin moneda: el badge no se pudo calcular ⇒ SIN_VERIFICAR.
    expect(por.get(id(5))).toMatchObject({ riesgo: 'SIN_VERIFICAR' });
    expect(r.no_existen).toEqual([id(9)]);
    expect(r.resumen).toEqual({
      n: 5,
      pendientes: 4,
      no_pendientes: 1,
      con_riesgo: 3,
    });
    expect(escrituras(w.log)).toHaveLength(0);
  });

  // Revisión del 14-oct-2026: la lectura de cobros exactos va PAGINADA por
  // la PK (antes `.limit(1000)`: un cobro exacto después de la fila 1000
  // daba 0 y el abono se omitía sin aviso) y falla CERRADO pasado el tope.
  const cobro = (n: number, monto: number): Row => ({
    id: `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    vuelo_id: null,
    monto,
    moneda: 'MXN',
    metodo_cobro: 'TRANSFERENCIA',
    fecha_cobro: '2026-09-25T12:00:00-05:00',
    comision_banco_monto: null,
    cobro_grupo_id: null,
    ingreso_anticipo_id: null,
  });
  const abono100 = () =>
    mov(1, '2026-09-25', 100, { tipo: 'ABONO', descripcion: 'SPEI' });

  it('el cobro exacto DESPUÉS de la fila 1,000 sí se ve (COBRO_QUE_CUADRA)', async () => {
    const cobros = Array.from({ length: 1200 }, (_, k) => cobro(k + 1, 777));
    cobros.push(cobro(5000, 100));
    const w = armar(
      mundo({ movimiento_bancario: [abono100()], cobro_vuelo: cobros }),
    );
    const r = await w.svc.revisarOmision([id(1)]);
    expect(r.movimientos[0].riesgo).toBe('COBRO_QUE_CUADRA');
  });

  it(`más de 3,000 cobros candidatos en la ventana ⇒ SIN_VERIFICAR (jamás un 0 falso)`, async () => {
    const cobros = Array.from({ length: 3000 }, (_, k) => cobro(k + 1, 777));
    const w = armar(
      mundo({ movimiento_bancario: [abono100()], cobro_vuelo: cobros }),
    );
    const r = await w.svc.revisarOmision([id(1)]);
    expect(r.movimientos[0].riesgo).toBe('SIN_VERIFICAR');
    // Por debajo del tope y sin exacto: sin riesgo.
    const w2 = armar(
      mundo({
        movimiento_bancario: [abono100()],
        cobro_vuelo: cobros.slice(0, 1500),
      }),
    );
    expect(
      (await w2.svc.revisarOmision([id(1)])).movimientos[0].riesgo,
    ).toBeNull();
  });

  it('un abono cuyos cobros no se pudieron revisar es SIN_VERIFICAR', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-09-25', 100, { tipo: 'ABONO', descripcion: 'SPEI' }),
      ],
    });
    const w = armar(db);
    sinCobros(w.svc).mockRejectedValue(new Error('timeout'));
    const r = await w.svc.revisarOmision([id(1)]);
    expect(r.movimientos[0].riesgo).toBe('SIN_VERIFICAR');
  });
});

describe('deshacer la omisión', () => {
  async function omitido(notas: string | null) {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-09-24', 1.12, { notas }),
        mov(2, '2026-09-25', 2),
      ],
    });
    const w = armar(db);
    sinCobros(w.svc);
    await w.svc.omitirMovimientos(
      { movimiento_ids: [id(1), id(2)], motivo: 'Comisión del banco' },
      USER,
      'Ale',
    );
    return w;
  }

  it('vuelven a Pendientes y las notas regresan BYTE A BYTE', async () => {
    const original = '  Nota de la oficina\r\ncon dos líneas  \n';
    const w = await omitido(original);
    const r = await w.svc.quitarOmision([id(1), id(2)], USER);
    expect(r.restaurados).toBe(2);
    const [m1, m2] = w.db.movimiento_bancario;
    expect([m1.conciliado, m1.clasificacion_id, m1.notas]).toEqual([
      false,
      null,
      original,
    ]);
    expect([m2.conciliado, m2.clasificacion_id, m2.notas]).toEqual([
      false,
      null,
      null,
    ]);
    expect(r.movimientos.map((m) => m.omision)).toEqual([null, null]);
  });

  it('409 MOVIMIENTO_NO_OMITIDO si alguno ya no está omitido (sin llamar la RPC)', async () => {
    const w = await omitido(null);
    w.db.movimiento_bancario.push(mov(3, '2026-09-26', 3));
    const antes = w.rpcs.length;
    const r = await rechazo(w.svc.quitarOmision([id(1), id(3)], USER));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MOVIMIENTO_NO_OMITIDO');
    expect(r.body.message).toBe(
      'No se restauró ninguno: 1 de los 2 ya no está omitido (26 sep · IVA - COMISIONES $3.00). Recarga la lista.',
    );
    expect(
      w.rpcs.slice(antes).filter((x) => x.nombre === RPC_QUITAR),
    ).toHaveLength(0);
  });

  it('503 sin la migración', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }), {
      omision: { sinMigracion: true },
    });
    const r = await rechazo(w.svc.quitarOmision([id(1)], USER));
    expect([r.status, r.body.error]).toEqual([
      503,
      'CONCILIACION_OMITIR_NO_DISPONIBLE',
    ]);
  });
});

describe('la lista, el resumen, el Excel y Paywise (lectores aditivos)', () => {
  async function conOmitidos() {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-09-24', 1.12, { notas: 'del banco' }),
        mov(2, '2026-09-25', 7),
        mov(3, '2026-09-26', 100),
        mov(4, '2026-09-27', 20, { cuenta_bancaria_id: CTA_USD }),
        mov(5, '2026-09-28', 50, { tipo: 'ABONO', cuenta_bancaria_id: PW }),
        mov(6, '2026-09-28', 60, { tipo: 'ABONO', cuenta_bancaria_id: PW }),
      ],
    });
    const w = armar(db);
    sinCobros(w.svc);
    await w.svc.omitirMovimientos(
      {
        movimiento_ids: [id(1), id(2), id(4), id(5)],
        motivo: 'Comisión o IVA del banco',
      },
      USER,
      'Alejandro Canales',
    );
    return w;
  }

  it('`solo_omitidos` filtra en el API y cada fila trae `omision`', async () => {
    const w = await conOmitidos();
    const r = await w.svc.list({
      solo_omitidos: true,
      limit: 100,
      offset: 0,
    });
    expect((r.data as Row[]).map((m) => m.id).sort()).toEqual([
      id(1),
      id(2),
      id(4),
      id(5),
    ]);
    expect((r.data as Row[])[0].omision).toEqual({
      motivo: 'Comisión o IVA del banco',
      por: 'Alejandro Canales',
      fecha: HOY,
    });
    const todos = await w.svc.list({ limit: 100, offset: 0 });
    const pendiente = (todos.data as Row[]).find((m) => m.id === id(3))!;
    expect(pendiente).toHaveProperty('omision', null);
  });

  it('`solo_omitidos` sin la canónica ⇒ vacío SIN leer movimientos; lectura caída ⇒ 503', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }));
    const r = await w.svc.list({
      solo_omitidos: true,
      limit: 100,
      offset: 0,
    });
    expect(r).toEqual({ data: [], count: 0, limit: 100, offset: 0 });
    // Solo las sondas de columnas (`limit 1`); la consulta de la lista no corre.
    expect(
      w.log.filter((o) => o.tabla === 'movimiento_bancario' && o.limite !== 1),
    ).toHaveLength(0);
    const w2 = armar(mundo(), {
      fake: {
        fallos: { 'conciliacion_clasificacion:select': { message: 'timeout' } },
      },
    });
    const e = await rechazo(
      w2.svc.list({ solo_omitidos: true, limit: 100, offset: 0 }),
    );
    expect([e.status, e.body.error]).toEqual([503, 'OMITIDOS_NO_DISPONIBLE']);
  });

  it('resumen: omitidos y monto omitido por cuenta (null si no se pudo leer la canónica)', async () => {
    const w = await conOmitidos();
    const r = (await w.svc.resumen()) as Array<Record<string, unknown>>;
    const de = (cta: string) => r.find((x) => x.cuenta_bancaria_id === cta)!;
    expect(de(CTA)).toMatchObject({ omitidos: 2, monto_omitido: 8.12 });
    expect(de(CTA_USD)).toMatchObject({ omitidos: 1, monto_omitido: 20 });
    expect(de(PW)).toMatchObject({ omitidos: 1, monto_omitido: 50 });
    const w2 = armar(
      mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }),
      {
        fake: {
          fallos: {
            'conciliacion_clasificacion:select': { message: 'timeout' },
          },
        },
      },
    );
    const r2 = (await w2.svc.resumen()) as Array<Record<string, unknown>>;
    expect(r2[0]).toMatchObject({ omitidos: null, monto_omitido: null });
  });

  it('Excel: Estatus «Omitido», «Conciliado con» = el motivo firmado, Notas sin la línea, subtítulo', async () => {
    const w = await conOmitidos();
    await w.svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    const arg = (w.generateTablaXlsx.mock.calls[0] as unknown[])[0] as {
      subtitulo: string;
      filas: unknown[][];
    };
    const fila = (monto: number) => arg.filas.find((f) => f[4] === monto)!;
    expect(fila(1.12).slice(6)).toEqual([
      'Omitido',
      'Omitido: Comisión o IVA del banco (Alejandro Canales, ' + HOY + ')',
      'del banco',
    ]);
    expect(fila(7)[8]).toBe('');
    expect(fila(100)[6]).toBe('PENDIENTE');
    expect(arg.subtitulo).toContain(
      '2 conciliados (2 omitidos) · 1 pendientes',
    );
  });

  it('Excel sin omitidos: subtítulo de siempre', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }));
    await w.svc.reporteXlsx(CTA, '2026-09-01', '2026-09-30', 'todos');
    const arg = (w.generateTablaXlsx.mock.calls[0] as unknown[])[0] as {
      subtitulo: string;
    };
    expect(arg.subtitulo).toContain('· 0 conciliados · 1 pendientes ·');
  });

  it('Paywise: el abono omitido sale del universo y se cuenta aparte', async () => {
    const w = await conOmitidos();
    const r = (await w.svc.auditoriaPaywise({
      desde: '2026-09-01',
      hasta: '2026-09-30',
      dias: 5,
    })) as { resumen: Record<string, unknown> };
    expect(r.resumen.movimientos_omitidos).toBe(1);
    expect(r.resumen.movimientos_paywise).toBe(1);
  });
});

describe('clasificar: canónica prohibida, `esperado`, omitidos y CAS', () => {
  it('400 USA_OMITIR al clasificar con la canónica o crearla a mano', async () => {
    const w = armar(
      mundo({
        conciliacion_clasificacion: [
          { id: 'c-omit', nombre: CANONICA, activo: true },
          { id: 'clasif-comision', nombre: 'Comisión del banco', activo: true },
        ],
        movimiento_bancario: [mov(1, '2026-09-24', 1)],
      }),
    );
    const r = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'c-omit', undefined, USER),
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      message:
        'Para omitir un movimiento usa «Omitir la conciliación»: pide el motivo y se deshace en la pestaña «Omitidos».',
      error: 'USA_OMITIR',
    });
    const r2 = await rechazo(
      w.svc.crearClasificacion('  omitido de la   conciliación ', USER),
    );
    expect([r2.status, r2.body.error]).toEqual([400, 'USA_OMITIR']);
    expect(escrituras(w.log)).toHaveLength(0);
    // El catálogo del diálogo NO la ofrece.
    const cat = (await w.svc.listClasificaciones()) as Row[];
    expect(cat.map((c) => c.nombre)).toEqual(['Comisión del banco']);
  });

  it('`esperado` distinto de lo vigente ⇒ 409 MOVIMIENTO_CAMBIO sin escribir', async () => {
    const w = armar(
      mundo({
        movimiento_bancario: [
          mov(1, '2026-09-24', 1, {
            conciliado: true,
            clasificacion_id: 'clasif-comision',
          }),
        ],
      }),
    );
    const r = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'clasif-comision', 'nota', USER, {
        esperado: null,
      }),
    );
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      message:
        'Este movimiento cambió mientras tanto (alguien lo vinculó, lo clasificó o lo omitió): recarga la lista y vuelve a intentarlo.',
      error: 'MOVIMIENTO_CAMBIO',
      details: {
        actual: {
          conciliado: true,
          clasificacion_id: 'clasif-comision',
          clasificacion: 'Comisión del banco',
        },
      },
    });
    expect(escrituras(w.log)).toHaveLength(0);
    // Con el esperado correcto sí edita (misma clasificación, notas).
    const ok = await w.svc.clasificarMovimiento(
      id(1),
      'clasif-comision',
      'nota nueva',
      USER,
      {
        esperado: 'clasif-comision',
      },
    );
    expect(ok).toMatchObject({ notas: 'nota nueva', omision: null });
  });

  it('omitido + «Quitar clasificación» = deshacer la omisión; otra clasificación ⇒ 409 MOVIMIENTO_OMITIDO', async () => {
    const db = mundo({
      movimiento_bancario: [mov(1, '2026-09-24', 1.12, { notas: 'del banco' })],
    });
    const w = armar(db);
    sinCobros(w.svc);
    await w.svc.omitirMovimientos(
      { movimiento_ids: [id(1)], motivo: 'Comisión del banco' },
      USER,
      'Ale',
    );
    const r = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'clasif-comision', undefined, USER),
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MOVIMIENTO_OMITIDO');
    expect(r.body.message).toBe(
      'Este movimiento se omitió de la conciliación (motivo: Comisión del banco): deshaz la omisión antes de vincularlo o clasificarlo.',
    );
    const quitada = await w.svc.clasificarMovimiento(
      id(1),
      null,
      undefined,
      USER,
    );
    expect(quitada).toMatchObject({
      id: id(1),
      omision: null,
      conciliado: false,
    });
    expect(db.movimiento_bancario[0]).toMatchObject({
      clasificacion_id: null,
      notas: 'del banco',
    });
  });

  it('un abono con lote de cobros (`cobros_n > 0`) no se clasifica', async () => {
    const w = armar(
      mundo({
        movimiento_bancario: [
          mov(1, '2026-09-24', 100, {
            tipo: 'ABONO',
            conciliado: true,
            cobros_n: 2,
          }),
        ],
      }),
    );
    const r = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'clasif-comision', undefined, USER),
    );
    expect(r.status).toBe(409);
  });

  it('CAS: si alguien lo vinculó entre la lectura y la escritura ⇒ 409 MOVIMIENTO_CAMBIO', async () => {
    const db = mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] });
    let vecesUpdate = 0;
    const w = armar(db, {
      fake: {
        antes: (op, d) => {
          if (
            op.tabla === 'movimiento_bancario' &&
            op.op === 'update' &&
            vecesUpdate++ === 0
          ) {
            const m = d.movimiento_bancario[0];
            m.conciliado = true;
            m.gasto_id = 'g-x';
            m.gastos_n = 1;
          }
        },
      },
    });
    const r = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'clasif-comision', undefined, USER),
    );
    expect([r.status, r.body.error]).toEqual([409, 'MOVIMIENTO_CAMBIO']);
    expect(db.movimiento_bancario[0].clasificacion_id).toBeNull();
  });

  it('sin `esperado` (panel viejo) la conducta de siempre', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }));
    const r = await w.svc.clasificarMovimiento(
      id(1),
      'clasif-comision',
      'x',
      USER,
    );
    expect(r).toMatchObject({
      conciliado: true,
      clasificacion_id: 'clasif-comision',
      omision: null,
    });
  });
});

describe('candados: un omitido no se liga por los caminos de siempre', () => {
  async function conOmitido(extra: Row = {}) {
    const db = mundo({
      gasto: [
        {
          id: 'g-1',
          monto: 1.12,
          moneda: 'MXN',
          medio_pago: 'TARJETA_CORP',
          conciliado: false,
          fecha_gasto: '2026-09-24',
        },
      ],
      movimiento_bancario: [mov(1, '2026-09-24', 1.12, extra)],
    });
    const w = armar(db);
    sinCobros(w.svc);
    // Tiene un gasto que cuadra: la oficina confirma el aviso.
    await w.svc.omitirMovimientos(
      {
        movimiento_ids: [id(1)],
        motivo: 'Comisión del banco',
        aceptar_riesgo_ids: [id(1)],
      },
      USER,
      'Ale',
    );
    return w;
  }

  it('gasto (RPC G): 409 MOVIMIENTO_OMITIDO sin llamar la RPC', async () => {
    const w = await conOmitido();
    const antes = w.rpcs.length;
    const r = await rechazo(w.svc.link(id(1), 'g-1', USER));
    expect([r.status, r.body.error]).toEqual([409, 'MOVIMIENTO_OMITIDO']);
    expect(w.rpcs.slice(antes).map((x) => x.nombre)).not.toContain(
      'conciliacion_ligar_cargo_gastos',
    );
  });

  it('cobro y «desvincular cobro»: 409 sin escribir (su UPDATE borraría la omisión)', async () => {
    const w = await conOmitido({ tipo: 'ABONO', monto: 1.12 });
    const escritas = escrituras(w.log).length;
    for (const liga of [
      { cobro_id: 'cobro-1' },
      { cobro_id: null, cobro_grupo_id: null },
    ]) {
      const r = await rechazo(w.svc.linkCobro(id(1), liga, USER));
      expect([r.status, r.body.error]).toEqual([409, 'MOVIMIENTO_OMITIDO']);
    }
    expect(escrituras(w.log).length).toBe(escritas);
  });

  it('ingreso: el rechazo de siempre, con el motivo de la omisión', async () => {
    const w = await conOmitido({ tipo: 'ABONO', monto: 1.12 });
    const r = await rechazo(w.svc.linkIngreso(id(1), 'ingreso-1', USER));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      message:
        'Este movimiento se omitió de la conciliación (motivo: Comisión del banco): deshaz la omisión antes de vincularlo o clasificarlo.',
      error: 'MOVIMIENTO_YA_LIGADO',
      details: { liga: 'CLASIFICACION', omitido: true },
    });
  });

  it('el trigger de la BD es el candado real (la RPC G sobre un omitido ⇒ 409, no 500)', async () => {
    const w = await conOmitido();
    // La omisión entró entre la lectura TS y la RPC (carrera): el candado TS
    // no la vio y la BD la rechaza.
    jest
      .spyOn(
        w.svc as unknown as { bloquearSiOmitido: () => Promise<void> },
        'bloquearSiOmitido',
      )
      .mockResolvedValue(undefined);
    const r = await rechazo(w.svc.link(id(1), 'g-1', USER));
    expect([r.status, r.body.error]).toEqual([409, 'MOVIMIENTO_OMITIDO']);
  });

  // Revisión del 14-oct-2026: el candado TS decide por el NOMBRE embebido en
  // la misma lectura; ya no depende del memo ni de otra consulta que falle.
  it('con la lectura de la canónica CAÍDA, el nombre embebido frena el «desvincular cobro» y «Clasificar» (sin escribir)', async () => {
    const w = await conOmitido({ tipo: 'ABONO', monto: 1.12 });
    (w.svc as unknown as { omitidoMemo: unknown }).omitidoMemo = null;
    jest
      .spyOn(
        w.svc as unknown as {
          idClasificacionOmitido: () => Promise<string | null>;
        },
        'idClasificacionOmitido',
      )
      .mockResolvedValue(null);
    const escritas = escrituras(w.log).length;
    const r = await rechazo(
      w.svc.linkCobro(id(1), { cobro_id: null, cobro_grupo_id: null }, USER),
    );
    expect([r.status, r.body.error]).toEqual([409, 'MOVIMIENTO_OMITIDO']);
    const r2 = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'clasif-comision', undefined, USER),
    );
    expect([r2.status, r2.body.error]).toEqual([409, 'MOVIMIENTO_OMITIDO']);
    expect(escrituras(w.log).length).toBe(escritas);
    // «Quitar clasificación» = deshacer por la RPC (no el UPDATE suelto).
    const quitada = await w.svc.clasificarMovimiento(
      id(1),
      null,
      undefined,
      USER,
    );
    expect(quitada).toMatchObject({
      id: id(1),
      omision: null,
      conciliado: false,
    });
  });

  it('la canónica como DESTINO de «Clasificar» se reconoce por nombre aunque la lectura de su id caiga ⇒ 400 USA_OMITIR', async () => {
    const w = armar(
      mundo({
        conciliacion_clasificacion: [
          { id: 'c-omit', nombre: CANONICA, activo: true },
        ],
        movimiento_bancario: [mov(1, '2026-09-24', 1)],
      }),
    );
    jest
      .spyOn(
        w.svc as unknown as {
          idClasificacionOmitido: () => Promise<string | null>;
        },
        'idClasificacionOmitido',
      )
      .mockResolvedValue(null);
    const r = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'c-omit', undefined, USER),
    );
    expect([r.status, r.body.error]).toEqual([400, 'USA_OMITIR']);
    expect(escrituras(w.log)).toHaveLength(0);
  });

  it('el trigger rechaza quitar la omisión por un UPDATE suelto de «Clasificar» (carrera) ⇒ 409 MOVIMIENTO_OMITIDO, no 500', async () => {
    const w = armar(mundo({ movimiento_bancario: [mov(1, '2026-09-24', 1)] }), {
      fake: {
        antes: (op) =>
          op.tabla === 'movimiento_bancario' && op.op === 'update'
            ? {
                code: '23514',
                message:
                  'MOVIMIENTO_OMITIDO: el movimiento se omitió de la conciliación; solo «Deshacer la omisión» lo regresa a pendiente o le quita la clasificación',
              }
            : undefined,
      },
    });
    const r = await rechazo(
      w.svc.clasificarMovimiento(id(1), 'clasif-comision', undefined, USER),
    );
    expect([r.status, r.body.error]).toEqual([409, 'MOVIMIENTO_OMITIDO']);
  });
});

describe('pre-cierre: omitidos del periodo', () => {
  it('cuenta y suma por moneda de la cuenta; sin canónica ⇒ 0; lectura caída ⇒ null', async () => {
    const db = mundo({
      movimiento_bancario: [
        mov(1, '2026-09-24', 1.12),
        mov(2, '2026-09-25', 7),
        mov(3, '2026-09-26', 20, { cuenta_bancaria_id: CTA_USD }),
        mov(4, '2026-10-02', 3),
      ],
    });
    const w = armar(db);
    expect(await w.svc.omitidosDelPeriodo('2026-09-01', '2026-09-30')).toEqual({
      count: 0,
      monto_mxn: 0,
      monto_usd: 0,
    });
    sinCobros(w.svc);
    await w.svc.omitirMovimientos(
      {
        movimiento_ids: [id(1), id(2), id(3), id(4)],
        motivo: 'Comisión del banco',
      },
      USER,
    );
    expect(await w.svc.omitidosDelPeriodo('2026-09-01', '2026-09-30')).toEqual({
      count: 3,
      monto_mxn: 8.12,
      monto_usd: 20,
    });
    const w2 = armar(mundo(), {
      fake: {
        fallos: { 'conciliacion_clasificacion:select': { message: 'timeout' } },
      },
    });
    expect(
      await w2.svc.omitidosDelPeriodo('2026-09-01', '2026-09-30'),
    ).toBeNull();
  });
});
