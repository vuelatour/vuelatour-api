import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  MENSAJE_MODO_BALANCE_INVALIDO,
  MODO_BALANCE_GENERAL_DEFAULT,
  MODOS_BALANCE_GENERAL,
  type ModoBalanceGeneral,
} from '../balance-general-modo.util';
import { BalanceAvionQuery } from './balance-avion.query';

/**
 * Descarga del Balance general VuelaTour (`GET
 * /v1/aircraft/balance-general.xlsx`): el periodo de siempre + `modo`
 * (6-oct-2026, API 0.0.64). Clase PROPIA y no un campo más en
 * `BalanceAvionQuery`: el libro de UN avión no tiene modos y, con
 * `forbidNonWhitelisted`, un `?modo=` ahí sigue siendo 400.
 */
export class BalanceGeneralQuery extends BalanceAvionQuery {
  @ApiPropertyOptional({
    enum: MODOS_BALANCE_GENERAL,
    default: MODO_BALANCE_GENERAL_DEFAULT,
    description:
      'mensual (default) = el libro completo de siempre («Balance mensual»). general = el mismo libro con la hoja de vuelos resumida a costo total y costo por hora (total de gastos ÷ tiempo volado ÷ T.C. ÷ 1.16), sin el desglose de operación/piloto/AFAC («Balance general»). Mismos números en los dos; cualquier otro valor ⇒ 400.',
  })
  @IsOptional()
  @IsIn(MODOS_BALANCE_GENERAL, { message: MENSAJE_MODO_BALANCE_INVALIDO })
  modo: ModoBalanceGeneral = MODO_BALANCE_GENERAL_DEFAULT;
}
