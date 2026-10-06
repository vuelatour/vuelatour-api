import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsOptional, validateSync } from 'class-validator';
import { ToBooleanQuery } from './to-boolean-query.decorator';

class QueryDePrueba {
  @IsOptional()
  @ToBooleanQuery()
  @IsBoolean()
  conciliado?: boolean;
}

/** Mismas opciones que el ValidationPipe global (main.ts). */
const COMO_EL_PIPE = { enableImplicitConversion: true };

describe('ToBooleanQuery con la conversión implícita del pipe global', () => {
  it.each([
    ['false', false],
    ['true', true],
    [false, false],
    [true, true],
    // 6-oct-2026: el panel manda `incluir_no_bancarios=1`.
    ['1', true],
    ['0', false],
  ] as const)('%p ⇒ %p', (entrada, esperado) => {
    const dto = plainToInstance(
      QueryDePrueba,
      { conciliado: entrada },
      COMO_EL_PIPE,
    );
    expect(dto.conciliado).toBe(esperado);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('ausente ⇒ undefined (sin filtro)', () => {
    const dto = plainToInstance(QueryDePrueba, {}, COMO_EL_PIPE);
    expect(dto.conciliado).toBeUndefined();
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('un valor que no es booleano NO se adivina: lo rechaza @IsBoolean', () => {
    for (const raro of ['quizas', '2', 'si', 'TRUE']) {
      const dto = plainToInstance(
        QueryDePrueba,
        { conciliado: raro },
        COMO_EL_PIPE,
      );
      expect(dto.conciliado).toBe(raro);
      expect(validateSync(dto).length).toBeGreaterThan(0);
    }
  });

  it('el bug que se corrige: sin leer el valor crudo, Boolean("false") es true', () => {
    class SinDecorador {
      @IsOptional()
      @IsBoolean()
      conciliado?: boolean;
    }
    const dto = plainToInstance(
      SinDecorador,
      { conciliado: 'false' },
      COMO_EL_PIPE,
    );
    expect(dto.conciliado).toBe(true);
  });
});
