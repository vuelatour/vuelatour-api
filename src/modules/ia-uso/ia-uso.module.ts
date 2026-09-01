import { Global, Module } from '@nestjs/common';
import { IaUsoService } from './ia-uso.service';

/**
 * Registro de consumo de IA (best-effort). @Global igual que SupabaseModule:
 * cualquier módulo con un call site de visión lo inyecta sin importar nada.
 */
@Global()
@Module({
  providers: [IaUsoService],
  exports: [IaUsoService],
})
export class IaUsoModule {}
