import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateGastoDto,
  ListGastosQuery,
  UpdateGastoDto,
} from './expenses.dto';

/**
 * Contrato del DTO de alta para `capturado_en` (7-sep-2026). El pipe global
 * corre con whitelist + forbidNonWhitelisted: si la llave no estuviera
 * declarada, la app recibiría 400 al mandarla — este spec lo fija.
 */
const OPCIONES = { whitelist: true, forbidNonWhitelisted: true };

const base = {
  categoria: 'COMIDA',
  monto: 250,
  moneda: 'MXN',
  fecha_gasto: '2026-09-05',
  medio_pago: 'EFECTIVO',
};

async function errores(plain: Record<string, unknown>) {
  const dto = plainToInstance(CreateGastoDto, plain);
  return validate(dto, OPCIONES);
}

describe('CreateGastoDto.capturado_en', () => {
  it('acepta un ISO 8601 con zona horaria', async () => {
    expect(
      await errores({ ...base, capturado_en: '2026-09-05T14:32:00-05:00' }),
    ).toHaveLength(0);
    expect(
      await errores({ ...base, capturado_en: '2026-09-05T19:32:00.123Z' }),
    ).toHaveLength(0);
  });

  it('es opcional: sin la llave el DTO sigue válido (panel, masivo)', async () => {
    expect(await errores({ ...base })).toHaveLength(0);
  });

  it('rechaza basura y fechas que no son ISO 8601', async () => {
    const e1 = await errores({ ...base, capturado_en: 'ayer 3pm' });
    expect(e1.map((e) => e.property)).toContain('capturado_en');
    const e2 = await errores({ ...base, capturado_en: 12345 });
    expect(e2.map((e) => e.property)).toContain('capturado_en');
    const e3 = await errores({ ...base, capturado_en: '05/09/2026 14:32' });
    expect(e3.map((e) => e.property)).toContain('capturado_en');
  });

  it('una llave no declarada sigue rechazada (whitelist estricta intacta)', async () => {
    const e = await errores({ ...base, capturado_por_alguien: 'x' });
    expect(e.map((x) => x.property)).toContain('capturado_por_alguien');
  });
});

describe('ListGastosQuery.orden', () => {
  it('acepta fecha | captura y rechaza otros', async () => {
    const ok = plainToInstance(ListGastosQuery, { orden: 'captura' });
    expect(await validate(ok, OPCIONES)).toHaveLength(0);
    const okFecha = plainToInstance(ListGastosQuery, { orden: 'fecha' });
    expect(await validate(okFecha, OPCIONES)).toHaveLength(0);
    const mal = plainToInstance(ListGastosQuery, { orden: 'monto' });
    expect((await validate(mal, OPCIONES)).map((e) => e.property)).toContain(
      'orden',
    );
  });

  it('capturado_desde/hasta siguen siendo YYYY-MM-DD', async () => {
    const ok = plainToInstance(ListGastosQuery, {
      capturado_desde: '2026-09-01',
      capturado_hasta: '2026-09-07',
    });
    expect(await validate(ok, OPCIONES)).toHaveLength(0);
  });

  it('capturado_desde/hasta rechazan un ISO con hora (el corte Cancún exige día puro)', async () => {
    // El servicio concatena `T00:00:00-05:00`: con hora armaría un timestamp
    // inválido y PostgREST respondería opaco en vez de un 400 legible.
    const mal = plainToInstance(ListGastosQuery, {
      capturado_desde: '2026-09-01T00:00:00Z',
      capturado_hasta: '07/09/2026',
    });
    const props = (await validate(mal, OPCIONES)).map((e) => e.property);
    expect(props).toContain('capturado_desde');
    expect(props).toContain('capturado_hasta');
  });
});

/**
 * `tua_incluida` (13-oct-2026, TUA sistémica, invariante 66): número ≥ 0 con
 * 2 decimales u omitido/null. Con el ValidationPipe de main.ts
 * (`enableImplicitConversion`) un `null` llega como null — jamás 0: «volver a
 * la lectura de la IA» no puede guardarse como «sin TUA».
 */
describe('CreateGastoDto / UpdateGastoDto · tua_incluida', () => {
  const PIPE = { enableImplicitConversion: true };
  /** El alta y el PATCH (`PartialType` hereda validación y `@Type`). */
  const CLASES: ReadonlyArray<new () => { tua_incluida?: number | null }> = [
    CreateGastoDto,
    UpdateGastoDto,
  ];

  it.each([
    ['559.63', 559.63, 559.63],
    ['0', 0, 0],
    ['texto «559.63»', '559.63', 559.63],
  ])('acepta %s', async (_n, valor, esperado) => {
    for (const Clase of CLASES) {
      const dto = plainToInstance(
        Clase,
        { ...base, tua_incluida: valor },
        PIPE,
      );
      expect(await validate(dto, OPCIONES)).toHaveLength(0);
      expect(dto.tua_incluida).toBe(esperado);
    }
  });

  it('null se conserva null (no 0) y ausente sigue ausente', async () => {
    for (const Clase of CLASES) {
      const conNull = plainToInstance(
        Clase,
        { ...base, tua_incluida: null },
        PIPE,
      );
      expect(await validate(conNull, OPCIONES)).toHaveLength(0);
      expect(conNull.tua_incluida).toBeNull();
      const sin = plainToInstance(Clase, { ...base }, PIPE);
      expect(await validate(sin, OPCIONES)).toHaveLength(0);
      expect(sin.tua_incluida).toBeUndefined();
    }
  });

  it.each([
    ['negativo', -1],
    ['texto', 'abc'],
    ['3 decimales', 1.234],
  ])('rechaza %s', async (_n, valor) => {
    for (const Clase of CLASES) {
      const dto = plainToInstance(
        Clase,
        { ...base, tua_incluida: valor },
        PIPE,
      );
      expect((await validate(dto, OPCIONES)).map((e) => e.property)).toContain(
        'tua_incluida',
      );
    }
  });
});
