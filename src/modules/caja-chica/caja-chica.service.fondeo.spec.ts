import { Logger } from '@nestjs/common';
import { CajaChicaService } from './caja-chica.service';
import type { SupabaseService } from '../supabase/supabase.service';
import { TipoMovimientoCaja } from './dto/caja-chica.dto';

/**
 * CAJA CHICA MADRE: A QUIÉN SE REPUSO Y CAJAS QUE FONDEA (15-oct-2026,
 * invariante 83). Pedidos del cliente sobre la caja de Mary Cruz (la que
 * fondea a Gregorio, Jimmy, Nelson…):
 *  · «que diga a quien le repuso en el movimiento» ⇒ cada ESPEJO del
 *    historial gana el ADITIVO `repuesto_a` (caja y dueño VIVO de la
 *    reposición que lo originó), en lote y best-effort.
 *  · «que pueda seleccionar a quien le va a reponer el fondo» ⇒ el detalle
 *    gana `cajas_fondeadas` con lo POR REPONER de cada caja hija según la
 *    MISMA fuente que su tarjeta y su Excel (última fila del libro).
 *  · La reposición a una hija se registra con la ruta de SIEMPRE (POST de
 *    movimientos del fondo hijo) y su espejo sale solo en la madre.
 */
type Row = Record<string, unknown>;
type Tablas = Record<string, Row[]>;

interface Consulta {
  tabla: string;
  sel: string;
  eqs: Array<{ col: string; val: unknown }>;
  ins: Array<{ col: string; vals: unknown[] }>;
}

let secuencia = 0;

/** Supabase falso por tabla con `eq`/`in`/`is` e `insert` (ids generados). */
function fakeSupabase(db: Tablas, falla?: (q: Consulta) => boolean) {
  const log: Consulta[] = [];
  const service = {
    from(tabla: string) {
      const q: Consulta = { tabla, sel: '', eqs: [], ins: [] };
      log.push(q);
      const filtros: Array<(r: Row) => boolean> = [];
      let insertada: Row | null = null;
      const ejecutar = (unico: boolean) => {
        if (falla?.(q)) return { data: null, error: { message: 'caída' } };
        if (insertada) return { data: insertada, error: null };
        const filas = (db[tabla] ?? []).filter((r) =>
          filtros.every((f) => f(r)),
        );
        return { data: unico ? (filas[0] ?? null) : filas, error: null };
      };
      const api: Record<string, unknown> = {
        select(s: string) {
          q.sel = s;
          return api;
        },
        insert(fila: Row) {
          // Defaults de la BD (fecha = `CURRENT_DATE` en UTC, created_at,
          // espejo null) solo donde el insert no trae valor. La fecha de
          // la BD es a propósito un día DISTINTO a cualquier «hoy» de las
          // pruebas: si el API dejara de mandar la fecha, se notaría.
          const definidos = Object.fromEntries(
            Object.entries(fila).filter(([, v]) => v !== undefined),
          );
          insertada = {
            id: `nuevo-${++secuencia}`,
            fecha: '1999-12-31',
            created_at: `2026-10-15T12:00:${String(secuencia).padStart(2, '0')}+00:00`,
            espejo_de_id: null,
            ...definidos,
          };
          (db[tabla] ??= []).push(insertada);
          return api;
        },
        eq(col: string, val: unknown) {
          q.eqs.push({ col, val });
          filtros.push((r) => r[col] === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          q.ins.push({ col, vals });
          filtros.push((r) => vals.includes(r[col]));
          return api;
        },
        is(col: string, val: unknown) {
          filtros.push((r) => (r[col] ?? null) === val);
          return api;
        },
        maybeSingle: () => Promise.resolve(ejecutar(true)),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(ejecutar(false)).then(res, rej),
      };
      return api;
    },
  };
  return { supabase: { service } as unknown as SupabaseService, log };
}

const MARY = 'f-mary';
const GREG = 'f-gregorio';
const JIMMY = 'f-jimmy';
const NELSON = 'f-nelson';

const fondo = (
  id: string,
  usuario: string,
  nombre: string,
  extra: Row = {},
): Row => ({
  id,
  usuario_id: usuario,
  moneda: 'MXN',
  activo: true,
  es_acumulada: false,
  monto_fondo: null,
  fondo_origen_id: MARY,
  usuario: { nombre, email: `${usuario}@x.mx`, rol: 'PILOTO' },
  ...extra,
});

const mov = (
  id: string,
  fondoId: string,
  tipo: string,
  monto: number,
  fecha: string,
  extra: Row = {},
): Row => ({
  id,
  fondo_id: fondoId,
  tipo,
  monto: monto.toFixed(2),
  moneda: 'MXN',
  fecha,
  autorizado_por: null,
  referencia: null,
  notas: null,
  registrado_por: 'u-mari',
  espejo_de_id: null,
  created_at: `${fecha}T15:00:00+00:00`,
  ...extra,
});

const espejo = (
  id: string,
  origenId: string,
  monto: number,
  fecha: string,
  a: string,
) =>
  mov(id, MARY, 'REINTEGRO', monto, fecha, {
    espejo_de_id: origenId,
    referencia: `Fondeo a ${a}`,
    notas: 'Espejo automático de la reposición en la caja vinculada.',
  });

const gasto = (
  id: string,
  usuario: string,
  monto: number,
  fecha: string,
  extra: Row = {},
): Row => ({
  id,
  monto,
  moneda: 'MXN',
  fecha_gasto: fecha,
  categoria: 'TAXI',
  lugar: 'CUN',
  notas: null,
  vuelo_id: null,
  medio_pago: 'EFECTIVO',
  usuario_captura_id: usuario,
  created_at: `${fecha}T18:00:00+00:00`,
  vuelo: null,
  escala: null,
  aeronave_id: null,
  escala_id: null,
  inventario_movimiento_id: null,
  ...extra,
});

function mundo(): Tablas {
  return {
    caja_chica_fondo: [
      fondo(MARY, 'u-mary', 'Mary Cruz', {
        fondo_origen_id: null,
        monto_fondo: 50000,
      }),
      // Acumulada: por reponer = lo gastado desde la última reposición.
      fondo(GREG, 'u-greg', 'Gregorio Jurado', { es_acumulada: true }),
      // Clásica con nominal y entregas: por reponer = nominal − saldo.
      fondo(JIMMY, 'u-jimmy', 'Jimmy Chi', { monto_fondo: 2000 }),
      // Libro vacío ⇒ 0 (lo mismo que su tarjeta y su Excel).
      fondo(NELSON, 'u-nelson', 'Nelson Hau'),
      // Cerrada: no se ofrece.
      fondo('f-cerrada', 'u-cerrada', 'Aaron Cerrado', { activo: false }),
      // Fondeada por OTRA madre: no es de Mary.
      fondo('f-ajena', 'u-ajena', 'Beto Ajeno', { fondo_origen_id: 'f-otra' }),
      fondo('f-otra', 'u-otra', 'Otra Madre', { fondo_origen_id: null }),
    ],
    caja_chica_movimiento: [
      mov('m-mary-ini', MARY, 'REPOSICION', 50000, '2026-10-01'),
      // Reintegro a mano (no espejo): no lleva `repuesto_a`.
      mov('m-mary-reint', MARY, 'REINTEGRO', 1000, '2026-10-02', {
        notas: 'Devolución a dirección',
      }),
      // Reposiciones de las hijas y sus espejos en Mary.
      mov('r-greg', GREG, 'REPOSICION', 1500, '2026-10-05'),
      espejo('e-greg', 'r-greg', 1500, '2026-10-05', 'Gregorio J.'),
      mov('r-jimmy', JIMMY, 'REPOSICION', 2000, '2026-10-03'),
      espejo('e-jimmy', 'r-jimmy', 2000, '2026-10-03', 'Jimmy Chi'),
      // Espejo cuyo origen ya no se encuentra ⇒ repuesto_a null.
      espejo('e-huerfano', 'r-borrada', 300, '2026-10-04', 'Alguien'),
    ],
    gasto: [
      gasto('g-greg-1', 'u-greg', 1200, '2026-10-04'),
      gasto('g-greg-2', 'u-greg', 450.5, '2026-10-08'),
      gasto('g-greg-3', 'u-greg', 99.5, '2026-10-09'),
      gasto('g-jimmy-1', 'u-jimmy', 700, '2026-10-07'),
      gasto('g-jimmy-usd', 'u-jimmy', 40, '2026-10-07', { moneda: 'USD' }),
    ],
    gasto_reparto: [],
    escala: [],
    aeronave: [],
  };
}

type Entrada = Record<string, unknown>;
type Detalle = Awaited<ReturnType<CajaChicaService['getFondoDetail']>>;

const LLAVES_BASE = [
  'id',
  'fecha',
  'origen',
  'tipo',
  'monto',
  'descripcion',
  'created_at',
  'vuelo_id',
  'vuelo_folio',
  'saldo',
  'por_reponer',
];

async function detalle(
  db: Tablas,
  id = MARY,
  falla?: (q: Consulta) => boolean,
) {
  const f = fakeSupabase(db, falla);
  const svc = new CajaChicaService(f.supabase);
  const d: Detalle = await svc.getFondoDetail(id);
  return { d, historial: d.historial as Entrada[], log: f.log, svc };
}
const porId = (h: Entrada[], id: string) => h.find((e) => e.id === id)!;

const esLecturaOrigenes = (q: Consulta) =>
  q.tabla === 'caja_chica_movimiento' && q.sel === 'id, fondo_id';
const esLecturaCajasOrigen = (q: Consulta) =>
  q.tabla === 'caja_chica_fondo' &&
  q.sel === 'id, usuario_id, usuario:usuario!usuario_id(nombre)';
const esLecturaHijas = (q: Consulta) =>
  q.tabla === 'caja_chica_fondo' &&
  q.eqs.some((e) => e.col === 'fondo_origen_id');

describe('CajaChicaService.getFondoDetail — `repuesto_a` de los espejos (invariante 83)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('cada espejo dice la caja y el dueño (nombre VIVO, no el de la referencia) de la reposición que lo originó', async () => {
    const { historial } = await detalle(mundo());
    expect(porId(historial, 'e-greg').repuesto_a).toEqual({
      fondo_id: GREG,
      usuario_id: 'u-greg',
      nombre: 'Gregorio Jurado',
    });
    expect(porId(historial, 'e-jimmy').repuesto_a).toEqual({
      fondo_id: JIMMY,
      usuario_id: 'u-jimmy',
      nombre: 'Jimmy Chi',
    });
    // La descripción sigue igual (skew-safe: el panel viejo pinta lo mismo).
    expect(porId(historial, 'e-greg').descripcion).toBe(
      'Espejo automático de la reposición en la caja vinculada.',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('origen que ya no se encuentra ⇒ la llave existe y vale null', async () => {
    const { historial } = await detalle(mundo());
    expect(porId(historial, 'e-huerfano')).toHaveProperty('repuesto_a', null);
  });

  it('solo los ESPEJOS llevan la llave (última); reintegros a mano, reposiciones y gastos quedan igual', async () => {
    const { historial } = await detalle(mundo());
    for (const e of historial) {
      const esEspejo = ['e-greg', 'e-jimmy', 'e-huerfano'].includes(
        e.id as string,
      );
      expect(Object.keys(e)).toEqual(
        esEspejo ? [...LLAVES_BASE, 'repuesto_a'] : LLAVES_BASE,
      );
    }
    // En la caja hija (sin espejos) nadie lleva la llave y no se lee nada.
    const hija = await detalle(mundo(), GREG);
    expect(JSON.stringify(hija.d.historial)).not.toContain('repuesto_a');
    expect(hija.log.filter(esLecturaOrigenes)).toHaveLength(0);
    expect(hija.log.filter(esLecturaCajasOrigen)).toHaveLength(0);
  });

  it('DOS lecturas en lote para todo el historial, sin ids repetidos', async () => {
    const { log } = await detalle(mundo());
    const origenes = log.filter(esLecturaOrigenes);
    expect(origenes).toHaveLength(1);
    expect(origenes[0].ins[0].col).toBe('id');
    expect([...(origenes[0].ins[0].vals as string[])].sort()).toEqual([
      'r-borrada',
      'r-greg',
      'r-jimmy',
    ]);
    const cajas = log.filter(esLecturaCajasOrigen);
    expect(cajas).toHaveLength(1);
    expect([...(cajas[0].ins[0].vals as string[])].sort()).toEqual([
      GREG,
      JIMMY,
    ]);
  });

  it('≤ 150 ids por `in`: 163 orígenes (160 nuevos + 3 del mundo) ⇒ dos consultas de orígenes (150 + 13)', async () => {
    const db = mundo();
    for (let i = 0; i < 160; i++) {
      db.caja_chica_movimiento.push(
        mov(`r-n${i}`, NELSON, 'REPOSICION', 10, '2026-10-06'),
        espejo(`e-n${i}`, `r-n${i}`, 10, '2026-10-06', 'Nelson'),
      );
    }
    const { log, historial } = await detalle(db);
    const tamanos = log
      .filter(esLecturaOrigenes)
      .map((q) => q.ins[0].vals.length);
    expect(tamanos).toEqual([150, 13]);
    expect(Math.max(...tamanos)).toBeLessThanOrEqual(150);
    expect(porId(historial, 'e-n159').repuesto_a).toEqual({
      fondo_id: NELSON,
      usuario_id: 'u-nelson',
      nombre: 'Nelson Hau',
    });
  });

  it.each([
    ['la de orígenes', esLecturaOrigenes],
    ['la de cajas de origen', esLecturaCajasOrigen],
  ])(
    'falla %s ⇒ NINGUNA entrada trae `repuesto_a`, warn, no lanza y los números no cambian',
    async (_n, falla) => {
      const bien = await detalle(mundo());
      const mal = await detalle(mundo(), MARY, falla);
      expect(JSON.stringify(mal.d)).not.toContain('repuesto_a');
      const sin = JSON.parse(
        JSON.stringify(bien.d, (k, v: unknown) =>
          k === 'repuesto_a' ? undefined : v,
        ),
      ) as unknown;
      expect(JSON.parse(JSON.stringify(mal.d))).toEqual(sin);
      expect(warn).toHaveBeenCalledWith(
        'Caja chica sin «a quién se repuso» en los espejos: caída',
      );
    },
  );
});

describe('CajaChicaService.getFondoDetail — `cajas_fondeadas` (invariante 83)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('solo las ACTIVAS que fondea ESTA caja, ordenadas por nombre, con su por reponer y última reposición', async () => {
    const { d } = await detalle(mundo());
    expect(d.cajas_fondeadas).toEqual([
      {
        fondo_id: GREG,
        usuario_id: 'u-greg',
        nombre: 'Gregorio Jurado',
        moneda: 'MXN',
        activo: true,
        // Acumulada: −1200 + 1500 − 450.5 − 99.5 = −250 ⇒ 250 (la
        // reposición del 5-oct sobró 300 y se arrastra).
        por_reponer: 250,
        ultima_reposicion: { fecha: '2026-10-05', monto: 1500 },
      },
      {
        fondo_id: JIMMY,
        usuario_id: 'u-jimmy',
        nombre: 'Jimmy Chi',
        moneda: 'MXN',
        activo: true,
        // Nominal 2000 − saldo 1300 (el gasto en USD no entra).
        por_reponer: 700,
        ultima_reposicion: { fecha: '2026-10-03', monto: 2000 },
      },
      {
        fondo_id: NELSON,
        usuario_id: 'u-nelson',
        nombre: 'Nelson Hau',
        moneda: 'MXN',
        activo: true,
        por_reponer: 0,
        ultima_reposicion: null,
      },
    ]);
    // `cajas_fondeadas` es la ÚLTIMA llave del detalle (aditiva).
    const llaves = Object.keys(d);
    expect(llaves[llaves.length - 1]).toBe('cajas_fondeadas');
    expect(warn).not.toHaveBeenCalled();
  });

  it('por_reponer = la última fila del libro de cada hija (la del Excel y la tarjeta de las CLÁSICAS); en las ACUMULADAS es su saldo con signo topado en 0', async () => {
    const { d } = await detalle(mundo());
    for (const c of d.cajas_fondeadas!) {
      const hija = await detalle(mundo(), c.fondo_id);
      // Última fila del libro = `porReponerDeFondo` del panel (tarjeta
      // «Por reponer» de las clásicas con nominal) y `por_reponer_antes`
      // del Excel de lo pendiente.
      const ultimaFila =
        hija.historial.length > 0
          ? (hija.historial[0].por_reponer as number)
          : 0;
      expect(c.por_reponer).toBe(ultimaFila);
      // Acumulada: la tarjeta «Por reponer (caja acumulada)» pinta
      // `fondo.saldo` CON signo; el selector lo topa en 0.
      if (hija.d.es_acumulada) {
        expect(c.por_reponer).toBe(Math.max(0, hija.d.saldo));
      }
    }
  });

  it('ACUMULADA repuesta de más: su tarjeta dice el saldo NEGATIVO y el selector 0 (lo que se prellena)', async () => {
    const db = mundo();
    // Gregorio: −1200 + 1500 − 450.5 − 99.5 + 600 = +350 repuesto de más.
    db.caja_chica_movimiento.push(
      mov('r-greg-2', GREG, 'REPOSICION', 600, '2026-10-10'),
    );
    const { d } = await detalle(db);
    const hija = await detalle(db, GREG);
    expect(hija.d.saldo).toBe(-350);
    expect(d.cajas_fondeadas!.find((c) => c.fondo_id === GREG)).toMatchObject({
      por_reponer: 0,
    });
  });

  it('una caja que no fondea a nadie ⇒ [] (no null)', async () => {
    const { d } = await detalle(mundo(), GREG);
    expect(d.cajas_fondeadas).toEqual([]);
  });

  it.each([
    ['la lectura de las hijas', esLecturaHijas],
    [
      'el libro de UNA hija',
      (q: Consulta) =>
        q.tabla === 'gasto' &&
        q.eqs.some(
          (e) => e.col === 'usuario_captura_id' && e.val === 'u-jimmy',
        ),
    ],
  ])(
    'falla %s ⇒ null (jamás un [] falso), warn, no lanza y el libro de la madre no cambia',
    async (_n, falla) => {
      const bien = await detalle(mundo());
      const mal = await detalle(mundo(), MARY, falla);
      expect(mal.d.cajas_fondeadas).toBeNull();
      expect(mal.d.historial).toEqual(bien.d.historial);
      expect(mal.d.saldo).toBe(bien.d.saldo);
      expect(warn).toHaveBeenCalledWith(
        'Caja chica sin «cajas que fondea»: caída',
      );
    },
  );

  it('carga los libros de las hijas en paralelo con TOPE de 4', async () => {
    const db = mundo();
    for (let i = 0; i < 9; i++) {
      db.caja_chica_fondo.push(fondo(`f-h${i}`, `u-h${i}`, `Hija ${i}`));
    }
    const f = fakeSupabase(db);
    const svc = new CajaChicaService(f.supabase);
    const interno = svc as unknown as {
      cargarLibro: (fo: Row) => Promise<unknown>;
    };
    const original = interno.cargarLibro.bind(svc);
    let vivas = 0;
    let maximo = 0;
    let llamadas = 0;
    interno.cargarLibro = async (fo: Row) => {
      if (fo.id === MARY) return original(fo);
      llamadas++;
      vivas++;
      maximo = Math.max(maximo, vivas);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await original(fo);
      } finally {
        vivas--;
      }
    };
    const d = await svc.getFondoDetail(MARY);
    expect(llamadas).toBe(12);
    expect(maximo).toBe(4);
    expect(d.cajas_fondeadas).toHaveLength(12);
  });
});

describe('Reponer a una caja hija desde la madre — ruta de SIEMPRE (invariante 83)', () => {
  /** Fija SOLO el reloj (`Date`); los timers y microtareas siguen reales. */
  const fijarReloj = (iso: string) => {
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
      ],
    });
    jest.setSystemTime(new Date(iso));
  };
  // Mediodía en Cancún del 15-oct-2026 (UTC y Cancún dicen el mismo día).
  beforeEach(() => fijarReloj('2026-10-15T17:00:00Z'));
  afterEach(() => jest.useRealTimers());

  it('sin fecha a las 19:30 de Cancún (ya «mañana» en UTC) ⇒ la reposición y su espejo quedan con el día de CANCÚN, no el de la BD', async () => {
    // 2026-10-16T00:30Z = 15-oct 19:30 Cancún (UTC−5).
    fijarReloj('2026-10-16T00:30:00Z');
    const db = mundo();
    // Gasto que Gregorio captura al día siguiente: NO está repuesto.
    db.gasto.push(gasto('g-greg-16', 'u-greg', 80, '2026-10-16'));
    const f = fakeSupabase(db);
    const svc = new CajaChicaService(f.supabase);
    const creado = (await svc.createMovimiento(
      GREG,
      { tipo: TipoMovimientoCaja.REPOSICION, monto: 250 },
      'u-mari',
    )) as Row;
    expect(creado.fecha).toBe('2026-10-15');
    const espejoNuevo = db.caja_chica_movimiento.find(
      (m) => m.espejo_de_id === creado.id,
    )!;
    expect(espejoNuevo.fecha).toBe('2026-10-15');

    const madre = await svc.getFondoDetail(MARY);
    expect(
      madre.cajas_fondeadas!.find((c) => c.fondo_id === GREG),
    ).toMatchObject({
      // El gasto del 16 va DESPUÉS de la reposición del 15: sigue pendiente.
      por_reponer: 80,
      ultima_reposicion: { fecha: '2026-10-15', monto: 250 },
    });
  });

  it('con fecha explícita se respeta tal cual (la reposición y su espejo)', async () => {
    const db = mundo();
    const svc = new CajaChicaService(fakeSupabase(db).supabase);
    const creado = (await svc.createMovimiento(
      GREG,
      { tipo: TipoMovimientoCaja.REPOSICION, monto: 100, fecha: '2026-10-10' },
      'u-mari',
    )) as Row;
    expect(creado.fecha).toBe('2026-10-10');
    expect(
      db.caja_chica_movimiento.find((m) => m.espejo_de_id === creado.id)!.fecha,
    ).toBe('2026-10-10');
  });

  it('POST de movimientos del fondo HIJO con REPOSICION: devuelve el movimiento con id y su espejo aparece en la madre con `repuesto_a`', async () => {
    const db = mundo();
    const f = fakeSupabase(db);
    const svc = new CajaChicaService(f.supabase);
    const creado = (await svc.createMovimiento(
      GREG,
      { tipo: TipoMovimientoCaja.REPOSICION, monto: 250 },
      'u-mari',
    )) as Row;
    expect(creado.id).toEqual(expect.any(String));
    expect(creado.fondo_id).toBe(GREG);

    const espejoNuevo = db.caja_chica_movimiento.find(
      (m) => m.espejo_de_id === creado.id,
    )!;
    expect(espejoNuevo).toMatchObject({
      fondo_id: MARY,
      tipo: 'REINTEGRO',
      monto: 250,
      referencia: 'Fondeo a Gregorio Jurado',
    });

    const madre = await svc.getFondoDetail(MARY);
    const fila = (madre.historial as Entrada[]).find(
      (e) => e.id === espejoNuevo.id,
    )!;
    expect(fila.repuesto_a).toEqual({
      fondo_id: GREG,
      usuario_id: 'u-greg',
      nombre: 'Gregorio Jurado',
    });
    // Tras reponer lo pendiente, la hija ya no tiene nada por reponer.
    expect(
      madre.cajas_fondeadas!.find((c) => c.fondo_id === GREG),
    ).toMatchObject({
      por_reponer: 0,
      ultima_reposicion: { fecha: '2026-10-15', monto: 250 },
    });
  });
});
