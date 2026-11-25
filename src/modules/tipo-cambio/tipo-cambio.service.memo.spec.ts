import {
  FUENTE_DIARIA,
  FUENTE_HISTORICA,
  TC_MEMO_TTL_CORTO_MS,
  TC_MEMO_TTL_PASADO_MS,
  TipoCambioService,
} from './tipo-cambio.service';
import {
  fakePostgrest,
  type ErrorFake,
  type OperacionFake,
  type Row,
} from '../conciliacion/conciliacion-postgrest.fixture-spec';

/**
 * MEMORIA DEL T.C. OFICIAL POR FECHA (25-nov-2026, invariante 145). La base
 * (Supabase Micro) se cayó tres veces ese día; en el minuto pico de la
 * tercera, 239 de 1,094 peticiones eran `tipo_cambio_oficial`: cada reporte
 * pide el T.C. día por día y nada lo recordaba entre peticiones.
 *
 * Días usados: 2026-09-xx son PASADOS (memoria de 10 min) y 2099-01-xx son
 * FUTUROS (memoria de 60 s, como el día de hoy).
 */
type FilaTc = { fecha: string; tc: number; fuente: string };
const FILAS: FilaTc[] = [
  { fecha: '2026-09-01', tc: 17.0077, fuente: FUENTE_DIARIA },
  { fecha: '2026-09-24', tc: 17.4691, fuente: FUENTE_DIARIA },
  { fecha: '2098-12-30', tc: 21.5, fuente: FUENTE_DIARIA },
];

function armar(filas: FilaTc[] = FILAS) {
  const db = { tipo_cambio_oficial: filas.map((f): Row => ({ ...f })) };
  const fallos: Record<string, ErrorFake> = {};
  const fake = fakePostgrest(db, { fallos });
  const svc = new TipoCambioService(fake.supabase);
  let reloj = 1_000_000;
  svc.ahoraMs = () => reloj;
  const lecturas = (): OperacionFake[] =>
    fake.log.filter(
      (o) => o.tabla === 'tipo_cambio_oficial' && o.op === 'select',
    );
  return {
    svc,
    db,
    fallos,
    lecturas,
    avanzar: (ms: number) => {
      reloj += ms;
    },
  };
}

function sinRed() {
  return jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('sin red en el spec'));
}

afterEach(() => jest.restoreAllMocks());

describe('oficialDetallePara — memoria por fecha', () => {
  it('40 llamadas simultáneas del mismo día = UNA lectura, y el mismo dato', async () => {
    const fetch = sinRed();
    const { svc, lecturas } = armar();
    const r = await Promise.all(
      Array.from({ length: 40 }, () => svc.oficialDetallePara('2026-09-03')),
    );
    expect(lecturas()).toHaveLength(1);
    for (const d of r) {
      expect(d).toEqual({
        tc: 17.0077,
        fecha_dato: '2026-09-01',
        fuente: FUENTE_DIARIA,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('día PASADO con dato: se recuerda 10 min y luego se vuelve a leer', async () => {
    sinRed();
    const { svc, lecturas, avanzar } = armar();
    expect((await svc.oficialDetallePara('2026-09-24'))?.tc).toBe(17.4691);
    avanzar(TC_MEMO_TTL_PASADO_MS - 1);
    expect((await svc.oficialDetallePara('2026-09-24'))?.tc).toBe(17.4691);
    expect(lecturas()).toHaveLength(1);
    avanzar(1);
    expect((await svc.oficialDetallePara('2026-09-24'))?.tc).toBe(17.4691);
    expect(lecturas()).toHaveLength(2);
  });

  it('cada día tiene su propia lectura (la llave es la fecha pedida)', async () => {
    sinRed();
    const { svc, lecturas } = armar();
    const [a, b] = await Promise.all([
      svc.oficialDetallePara('2026-09-02'),
      svc.oficialDetallePara('2026-09-25'),
    ]);
    expect(a?.fecha_dato).toBe('2026-09-01');
    expect(b?.fecha_dato).toBe('2026-09-24');
    expect(lecturas()).toHaveLength(2);
    await svc.oficialDetallePara('2026-09-02');
    await svc.oficialDetallePara('2026-09-25');
    expect(lecturas()).toHaveLength(2);
  });

  it('HOY o futuro: la memoria dura solo 60 s', async () => {
    const fetch = sinRed();
    const { svc, lecturas, avanzar } = armar();
    expect((await svc.oficialDetallePara('2099-01-01'))?.tc).toBe(21.5);
    avanzar(TC_MEMO_TTL_CORTO_MS - 1);
    await svc.oficialDetallePara('2099-01-01');
    expect(lecturas()).toHaveLength(1);
    avanzar(1);
    await svc.oficialDetallePara('2099-01-01');
    expect(lecturas()).toHaveLength(2);
    // El dato (2098-12-30) no es anterior a hoy: no se intenta descargar.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('devuelve un objeto NUEVO por llamada: mutarlo no ensucia la memoria', async () => {
    sinRed();
    const { svc } = armar();
    const a = await svc.oficialDetallePara('2026-09-03');
    expect(a).not.toBeNull();
    a!.tc = 999;
    a!.fuente = 'alterada';
    const b = await svc.oficialDetallePara('2026-09-03');
    expect(b).toEqual({
      tc: 17.0077,
      fecha_dato: '2026-09-01',
      fuente: FUENTE_DIARIA,
    });
    expect(b).not.toBe(a);
  });

  it('`oficialPara` sale de la misma memoria', async () => {
    sinRed();
    const { svc, lecturas } = armar();
    expect(await svc.oficialPara('2026-09-03')).toBe(17.0077);
    expect(await svc.oficialPara('2026-09-03')).toBe(17.0077);
    expect((await svc.oficialDetallePara('2026-09-03'))?.tc).toBe(17.0077);
    expect(lecturas()).toHaveLength(1);
  });
});

describe('oficialDetallePara — lo que NO se recuerda', () => {
  it('un error de lectura ⇒ null y la siguiente llamada vuelve a leer', async () => {
    sinRed();
    const { svc, fallos, lecturas } = armar();
    fallos['tipo_cambio_oficial:select'] = { message: 'timeout' };
    expect(await svc.oficialDetallePara('2026-09-03')).toBeNull();
    expect(lecturas()).toHaveLength(1);
    // La base vuelve: sin esperar a que venza nada, ya responde el dato.
    delete fallos['tipo_cambio_oficial:select'];
    expect((await svc.oficialDetallePara('2026-09-03'))?.tc).toBe(17.0077);
    expect(lecturas()).toHaveLength(2);
  });

  it('las simultáneas de una lectura fallida reciben null y ninguna queda guardada', async () => {
    sinRed();
    const { svc, fallos, lecturas } = armar();
    fallos['tipo_cambio_oficial:select'] = { message: 'timeout' };
    const r = await Promise.all(
      Array.from({ length: 10 }, () => svc.oficialDetallePara('2026-09-03')),
    );
    expect(r.every((d) => d === null)).toBe(true);
    expect(lecturas()).toHaveLength(1);
    delete fallos['tipo_cambio_oficial:select'];
    expect((await svc.oficialDetallePara('2026-09-03'))?.tc).toBe(17.0077);
  });

  it('«sin dato» de un día pasado se recuerda solo 60 s (puede llenarse después)', async () => {
    // Sin fila en los 7 días anteriores y sin red: no hay dato.
    const fetch = sinRed();
    const { svc, db, lecturas, avanzar } = armar();
    expect(await svc.oficialDetallePara('2026-06-15')).toBeNull();
    const trasLaPrimera = lecturas().length;
    expect(fetch).toHaveBeenCalledTimes(1);
    // Dentro de los 60 s no se vuelve a leer ni a descargar.
    avanzar(TC_MEMO_TTL_CORTO_MS - 1);
    expect(await svc.oficialDetallePara('2026-06-15')).toBeNull();
    expect(lecturas()).toHaveLength(trasLaPrimera);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Alguien llena el día: a los 60 s ya se ve (no a los 10 min).
    db.tipo_cambio_oficial.push({
      fecha: '2026-06-15',
      tc: 18.9,
      fuente: FUENTE_HISTORICA,
    });
    avanzar(1);
    expect((await svc.oficialDetallePara('2026-06-15'))?.tc).toBe(18.9);
  });

  it('una fecha inválida no consulta ni ocupa memoria', async () => {
    sinRed();
    const { svc, lecturas } = armar();
    expect(await svc.oficialDetallePara('2026-13-01')).toBeNull();
    expect(await svc.oficialDetallePara('no-es-fecha')).toBeNull();
    expect(lecturas()).toHaveLength(0);
  });
});

describe('las descargas que escriben la tabla vacían la memoria', () => {
  it('`descargarHoy` con éxito ⇒ la siguiente lectura va a la base', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ result: 'success', rates: { MXN: 19.4 } }),
        {
          status: 200,
        },
      ),
    );
    const { svc, lecturas } = armar();
    await svc.oficialDetallePara('2026-09-03');
    await svc.oficialDetallePara('2026-09-03');
    expect(lecturas()).toHaveLength(1);
    expect(await svc.descargarHoy()).toBe(19.4);
    await svc.oficialDetallePara('2026-09-03');
    expect(lecturas()).toHaveLength(2);
  });

  it('`descargarHistorico` con éxito ⇒ también', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ date: '2026-06-12', rates: { MXN: 18.5 } }),
          { status: 200 },
        ),
      );
    const { svc, lecturas } = armar();
    await svc.oficialDetallePara('2026-09-03');
    expect(lecturas()).toHaveLength(1);
    expect(await svc.descargarHistorico('2026-06-13')).toBe(18.5);
    await svc.oficialDetallePara('2026-09-03');
    expect(lecturas()).toHaveLength(2);
  });

  it('una descarga que FALLA no la vacía', async () => {
    sinRed();
    const { svc, lecturas } = armar();
    await svc.oficialDetallePara('2026-09-03');
    expect(await svc.descargarHoy()).toBeNull();
    await svc.oficialDetallePara('2026-09-03');
    expect(lecturas()).toHaveLength(1);
  });

  it('un día pasado SIN dato que se descarga: la misma llamada ya lo devuelve', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ date: '2026-06-15', rates: { MXN: 18.75 } }),
          { status: 200 },
        ),
      );
    const { svc } = armar();
    expect(await svc.oficialDetallePara('2026-06-15')).toEqual({
      tc: 18.75,
      fecha_dato: '2026-06-15',
      fuente: FUENTE_HISTORICA,
    });
    // Y la siguiente también (ya está en la tabla).
    expect((await svc.oficialDetallePara('2026-06-15'))?.tc).toBe(18.75);
  });
});
