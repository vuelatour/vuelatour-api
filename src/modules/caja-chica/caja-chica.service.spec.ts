import { BadRequestException } from '@nestjs/common';
import { CajaChicaService } from './caja-chica.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * Historial de MI caja (GET /v1/me/caja-chica/movimientos) y detalle del
 * panel: el mismo libro produce las mismas cifras por fila. Supabase se
 * simula por tabla; aquí no se prueba la BD, sino el contrato de salida
 * (signos, orden, ventana Cancún, acumulado por reponer).
 */
describe('CajaChicaService — historial con saldo corrido', () => {
  const USER = 'u-piloto';
  const FONDO_ID = 'f-1';

  type Resultado = { data: unknown; error: null | { message: string } };

  /** Builder encadenable que resuelve `resultado` en cualquier terminal. */
  function consulta(resultado: Resultado) {
    const q: Record<string, unknown> = {};
    const self = () => q;
    Object.assign(q, {
      select: self,
      eq: self,
      in: self,
      order: self,
      limit: self,
      maybeSingle: () => Promise.resolve(resultado),
      then: (
        resolve: (v: Resultado) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(resultado).then(resolve, reject),
    });
    return q;
  }

  function servicio(tablas: Record<string, Resultado>) {
    const supabase = {
      service: {
        from: (tabla: string) =>
          consulta(tablas[tabla] ?? { data: [], error: null }),
      },
    } as unknown as SupabaseService;
    return new CajaChicaService(supabase);
  }

  const fondoAcumulada = {
    id: FONDO_ID,
    usuario_id: USER,
    moneda: 'MXN',
    activo: true,
    es_acumulada: true,
    monto_fondo: null,
    usuario: { nombre: 'Luis Piloto', email: 'l@x.mx', rol: 'PILOTO' },
  };

  // Libro real (prod 5-sep-2026): gastos de agosto/septiembre y el corte
  // del 5-sep que "cancela el fondo hasta esta fecha".
  const movimientos = [
    {
      id: 'm-repo',
      fondo_id: FONDO_ID,
      tipo: 'REPOSICION',
      monto: '13341.12',
      moneda: 'MXN',
      fecha: '2026-09-05',
      autorizado_por: 'u-ale',
      referencia: null,
      notas: 'Se cancela el fondo hasta esta fecha para iniciar de cero',
      registrado_por: 'u-mari',
      espejo_de_id: null,
      created_at: '2026-09-05T15:10:00+00:00',
      autorizado: { nombre: 'Ale' },
      registrado: [{ nombre: 'Mari' }],
    },
  ];
  const gastos = [
    {
      id: 'g-1',
      monto: 8000,
      moneda: 'MXN',
      fecha_gasto: '2026-08-20',
      categoria: 'GAS',
      lugar: 'CUN',
      notas: null,
      vuelo_id: 'v-1',
      created_at: '2026-08-20T18:00:00+00:00',
      vuelo: { folio: 101 },
    },
    {
      id: 'g-2',
      monto: '5341.12',
      moneda: 'MXN',
      fecha_gasto: '2026-09-05',
      categoria: 'ALIMENTOS',
      lugar: null,
      notas: 'Comida tripulación',
      vuelo_id: null,
      // Capturado DESPUÉS de la reposición del mismo día: aun así va antes
      // en el libro (la reposición del día salda los gastos del día).
      created_at: '2026-09-05T21:00:00+00:00',
      vuelo: null,
    },
    {
      id: 'g-3',
      monto: 250,
      moneda: 'MXN',
      fecha_gasto: '2026-09-06',
      categoria: 'TAXI',
      lugar: 'MID',
      notas: null,
      vuelo_id: null,
      created_at: '2026-09-06T12:00:00+00:00',
      vuelo: null,
    },
    // Otra moneda: NO entra al libro del fondo MXN.
    {
      id: 'g-usd',
      monto: 40,
      moneda: 'USD',
      fecha_gasto: '2026-09-06',
      categoria: 'TAXI',
      lugar: null,
      notas: null,
      vuelo_id: null,
      created_at: '2026-09-06T13:00:00+00:00',
      vuelo: null,
    },
  ];

  const tablas = {
    caja_chica_fondo: { data: fondoAcumulada, error: null },
    caja_chica_movimiento: { data: movimientos, error: null },
    gasto: { data: gastos, error: null },
  };

  afterEach(() => jest.useRealTimers());

  it('devuelve el libro DESC con saldo_despues (signo del panel) y por_reponer_despues en positivo', async () => {
    const svc = servicio(tablas);
    const r = await svc.getMyHistorial(USER, {
      desde: '2026-08-01',
      limit: 500,
    });

    expect(r.fondo).toMatchObject({
      id: FONDO_ID,
      moneda: 'MXN',
      es_acumulada: true,
      monto_fondo: null,
      saldo: 250, // igual que GET /caja-chica/me (positivo = por reponer)
      saldo_libro: -250,
      por_reponer: 250,
      usado: 250,
      ultima_reposicion: { fecha: '2026-09-05', monto: 13341.12 },
    });
    expect(r.count).toBe(4);
    expect(r.truncado).toBe(false);
    expect(r.movimientos.map((m) => m.id)).toEqual([
      'g-3',
      'm-repo',
      'g-2',
      'g-1',
    ]);
    expect(r.movimientos.map((m) => m.monto)).toEqual([
      -250, 13341.12, -5341.12, -8000,
    ]);
    expect(r.movimientos.map((m) => m.saldo_despues)).toEqual([
      -250, 0, -13341.12, -8000,
    ]);
    expect(r.movimientos.map((m) => m.por_reponer_despues)).toEqual([
      250, 0, 13341.12, 8000,
    ]);
  });

  it('cada fila trae concepto, descripción (criterio del panel), nota cruda, folio y nombres', async () => {
    const svc = servicio(tablas);
    const r = await svc.getMyHistorial(USER, {
      desde: '2026-08-01',
      limit: 500,
    });
    const [g3, repo, g2, g1] = r.movimientos;

    expect(repo).toMatchObject({
      origen: 'caja',
      tipo: 'REPOSICION',
      fecha: '2026-09-05',
      moneda: 'MXN',
      concepto: 'Reposición',
      descripcion: 'Se cancela el fondo hasta esta fecha para iniciar de cero',
      nota: 'Se cancela el fondo hasta esta fecha para iniciar de cero',
      referencia: null,
      categoria: null,
      folio_vuelo: null,
      vuelo_id: null,
      gasto_id: null,
      movimiento_id: 'm-repo',
      registrado_por_nombre: 'Mari',
      autorizado_por_nombre: 'Ale',
    });
    expect(g1).toMatchObject({
      origen: 'gasto',
      tipo: 'GASTO',
      concepto: 'Gasto en efectivo',
      categoria: 'GAS',
      lugar: 'CUN',
      nota: null,
      folio_vuelo: 101,
      vuelo_id: 'v-1',
      gasto_id: 'g-1',
      movimiento_id: null,
      registrado_por_nombre: 'Luis Piloto',
      autorizado_por_nombre: null,
    });
    // Sin notas: la descripción es la etiqueta de la categoría (como el panel).
    expect(typeof g1.descripcion).toBe('string');
    expect(g1.descripcion).toBe(g1.categoria_label);
    expect(g2.descripcion).toBe('Comida tripulación');
    expect(g3.id).toBe('g-3');
  });

  it('la ventana recorta DESPUÉS del corrido: el saldo de la primera fila visible ya trae lo anterior', async () => {
    const svc = servicio(tablas);
    const r = await svc.getMyHistorial(USER, {
      desde: '2026-09-05',
      hasta: '2026-09-05',
      limit: 500,
    });
    expect(r.count).toBe(2);
    expect(r.movimientos.map((m) => m.id)).toEqual(['m-repo', 'g-2']);
    // g-2 arrastra los $8,000 de agosto aunque agosto no se devuelva.
    expect(r.movimientos[1].por_reponer_despues).toBe(13341.12);
    // El fondo NO depende de la ventana.
    expect(r.fondo?.por_reponer).toBe(250);
  });

  it('limit recorta a los más recientes y avisa truncado; count es el total de la ventana', async () => {
    const svc = servicio(tablas);
    const r = await svc.getMyHistorial(USER, {
      desde: '2026-08-01',
      limit: 2,
    });
    expect(r.count).toBe(4);
    expect(r.truncado).toBe(true);
    expect(r.movimientos.map((m) => m.id)).toEqual(['g-3', 'm-repo']);
  });

  it('default: últimos 6 meses en día Cancún (a las 00:30 UTC del 6 todavía es 5-sep)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-06T00:30:00Z'));
    const svc = servicio(tablas);
    const r = await svc.getMyHistorial(USER, {
      limit: 500,
    });
    expect(r.desde).toBe('2026-03-05');
    expect(r.hasta).toBeNull();
    expect(r.count).toBe(4);
  });

  it('sin fondo activo → fondo:null y lista vacía (nunca 404: la app cachea)', async () => {
    const svc = servicio({
      ...tablas,
      caja_chica_fondo: { data: null, error: null },
    });
    const r = await svc.getMyHistorial(USER, {
      limit: 500,
    });
    expect(r.fondo).toBeNull();
    expect(r.movimientos).toEqual([]);
    expect(r.count).toBe(0);
  });

  it('rechaza hasta < desde y fechas inválidas con 400', async () => {
    const svc = servicio(tablas);
    await expect(
      svc.getMyHistorial(USER, {
        desde: '2026-09-05',
        hasta: '2026-09-01',
        limit: 500,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.getMyHistorial(USER, {
        desde: '2026-13-40',
        limit: 500,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Día inexistente (Date.parse lo desbordaría a marzo): también 400.
    await expect(
      svc.getMyHistorial(USER, {
        desde: '2026-02-31',
        limit: 500,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.getMyHistorial(USER, {
        desde: '2026-02-01',
        hasta: '2026-04-31',
        limit: 500,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un error de BD en gastos o movimientos tumba la lectura (jamás saldo con datos parciales)', async () => {
    const svc = servicio({
      ...tablas,
      gasto: { data: null, error: { message: 'boom' } },
    });
    await expect(svc.getMyHistorial(USER, { limit: 500 })).rejects.toThrow(
      'boom',
    );
  });

  it('el detalle del panel (getFondoDetail) sale del MISMO libro: mismas filas y saldos, en DESC', async () => {
    const svc = servicio(tablas);
    const detalle = await svc.getFondoDetail(FONDO_ID);
    // `saldo` del detalle = mismo signo que la lista y que /caja-chica/me
    // (acumulada: positivo = por reponer); el crudo del libro va aparte.
    expect(detalle.saldo).toBe(250);
    expect(detalle.saldo_libro).toBe(-250);
    const mio = await svc.getMyHistorial(USER, { limit: 500 });
    expect(detalle.saldo).toBe(mio.fondo?.saldo);
    expect(detalle.saldo_libro).toBe(mio.fondo?.saldo_libro);
    expect(detalle.historial.map((e) => e.id)).toEqual([
      'g-3',
      'm-repo',
      'g-2',
      'g-1',
    ]);
    expect(detalle.historial.map((e) => e.saldo)).toEqual([
      -250, 0, -13341.12, -8000,
    ]);
    expect(detalle.historial.map((e) => e.por_reponer)).toEqual([
      250, 0, 13341.12, 8000,
    ]);
    expect(detalle.historial[1]).toMatchObject({
      origen: 'caja',
      tipo: 'REPOSICION',
      monto: 13341.12,
      descripcion: 'Se cancela el fondo hasta esta fecha para iniciar de cero',
    });
    expect(detalle.historial[3]).toMatchObject({
      origen: 'gasto',
      tipo: 'GASTO',
      vuelo_folio: 101,
    });
    expect(detalle.ultima_reposicion).toEqual({
      fecha: '2026-09-05',
      monto: 13341.12,
    });
  });

  it('caja CLÁSICA con nominal: por_reponer_despues = nominal − saldo tras la entrega', async () => {
    const svc = servicio({
      caja_chica_fondo: {
        data: {
          ...fondoAcumulada,
          es_acumulada: false,
          monto_fondo: '6000.00',
        },
        error: null,
      },
      caja_chica_movimiento: {
        data: [
          {
            ...movimientos[0],
            id: 'm-entrega',
            monto: 6000,
            fecha: '2026-08-02',
            notas: null,
            referencia: 'Entrega inicial',
            created_at: '2026-08-02T15:00:00+00:00',
          },
        ],
        error: null,
      },
      gasto: {
        data: [
          { ...gastos[0], id: 'g-a', monto: 1000, fecha_gasto: '2026-08-03' },
        ],
        error: null,
      },
    });
    const r = await svc.getMyHistorial(USER, {
      desde: '2026-08-01',
      limit: 500,
    });
    expect(r.fondo).toMatchObject({
      es_acumulada: false,
      monto_fondo: 6000,
      saldo: 5000,
      saldo_libro: 5000,
      por_reponer: 1000,
      usado: 1000,
      disponible: 5000,
    });
    expect(r.movimientos.map((m) => m.saldo_despues)).toEqual([5000, 6000]);
    expect(r.movimientos.map((m) => m.por_reponer_despues)).toEqual([1000, 0]);
    expect(r.movimientos[1].descripcion).toBe('Entrega inicial');
  });
});
