import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAeronaveDto } from './create-aeronave.dto';
import { UpdateAeronaveDto } from './update-aeronave.dto';
import { MENSAJE_COMBUSTIBLE_INVALIDO } from '../../../common/combustible.util';

/**
 * `combustible` en la ficha del avión (5-oct-2026, API 0.0.56). Misma
 * configuración del ValidationPipe de main.ts (whitelist +
 * forbidNonWhitelisted + conversión implícita): sin el campo declarado, el
 * panel nuevo recibiría 400 por propiedad no permitida.
 */
const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;
const BASE = {
  matricula: 'XB-PEV',
  modelo: 'Cessna 205',
  pais_registro: 'MX',
  num_motores: 1,
  velocidad_crucero_kts: 140,
  asientos: 5,
};

async function errores(
  cls: typeof CreateAeronaveDto | typeof UpdateAeronaveDto,
  plain: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, plain, { enableImplicitConversion: true });
  return validate(dto, OPTS);
}

describe('CreateAeronaveDto / UpdateAeronaveDto — combustible', () => {
  it('alta sin combustible (panel/API previo) pasa: la BD/servicio ponen AVGAS', async () => {
    expect(await errores(CreateAeronaveDto, BASE)).toEqual([]);
  });

  it('alta con AVGAS o TURBOSINA pasa', async () => {
    for (const combustible of ['AVGAS', 'TURBOSINA']) {
      expect(
        await errores(CreateAeronaveDto, { ...BASE, combustible }),
      ).toEqual([]);
    }
  });

  it('valor fuera del catálogo ⇒ 400 con el texto es-MX', async () => {
    for (const combustible of ['DIESEL', 'avgas', 'JET-A']) {
      const errs = await errores(CreateAeronaveDto, { ...BASE, combustible });
      expect(errs.map((e) => e.property)).toEqual(['combustible']);
      expect(Object.values(errs[0].constraints ?? {})).toEqual([
        MENSAJE_COMBUSTIBLE_INVALIDO,
      ]);
    }
  });

  it('edición: solo combustible pasa; null = sin cambio (el servicio lo omite)', async () => {
    expect(
      await errores(UpdateAeronaveDto, { combustible: 'TURBOSINA' }),
    ).toEqual([]);
    expect(await errores(UpdateAeronaveDto, { combustible: null })).toEqual([]);
    const errs = await errores(UpdateAeronaveDto, { combustible: 'GAS' });
    expect(errs.map((e) => e.property)).toEqual(['combustible']);
  });
});
